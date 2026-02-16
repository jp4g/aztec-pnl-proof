import { Account } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { createLogger } from "@aztec/aztec.js/log";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  AccountManager,
  type DeployAccountOptions,
} from "@aztec/aztec.js/wallet";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import type { FieldsOf } from "@aztec/foundation/types";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr/lazy";
import { AuditableWallet } from "@aztec/note-collector/client/wallet";
import { createBrowserAuditablePXE } from "@aztec/note-collector/client/browser";
import { getPXEConfig } from "@aztec/pxe/config";
import { type FeeOptions } from "@aztec/wallet-sdk/base-wallet";
import { GasSettings } from "@aztec/stdlib/gas";

const logger = createLogger("privdex:wallet");
const LOCAL_STORAGE_KEY = "privdex-aztec-account";

export class EmbeddedAuditableWallet extends AuditableWallet {
  connectedAccount: AztecAddress | null = null;
  protected accounts: Map<string, Account> = new Map();

  protected async getAccountFromAddress(
    address: AztecAddress
  ): Promise<Account> {
    if (address.equals(AztecAddress.ZERO)) {
      const { SignerlessAccount } = await import("@aztec/aztec.js/account");
      const chainInfo = await this.getChainInfo();
      return new SignerlessAccount(chainInfo);
    }
    const account = this.accounts.get(address?.toString() ?? "");
    if (!account) {
      throw new Error(`Account not found for address: ${address}`);
    }
    return account;
  }

  getAccounts() {
    return Promise.resolve(
      Array.from(this.accounts.values()).map((acc) => ({
        alias: "",
        item: acc.getAddress(),
      }))
    );
  }

  static async initialize(nodeUrl: string) {
    const aztecNode = createAztecNodeClient(nodeUrl);

    const config = getPXEConfig();
    config.proverEnabled = false;
    const pxe = await createBrowserAuditablePXE(aztecNode, config, {
      useLogSuffix: true,
    });

    // Register sponsored FPC on the PXE
    const { SponsoredFPCContractArtifact } = await import(
      "@aztec/noir-contracts.js/SponsoredFPC"
    );
    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact,
      { salt: new Fr(SPONSORED_FPC_SALT) }
    );
    await pxe.registerContract({
      instance: fpcInstance,
      artifact: SponsoredFPCContractArtifact,
    });

    const nodeInfo = await aztecNode.getNodeInfo();
    logger.info("PXE connected to node", nodeInfo);
    return new EmbeddedAuditableWallet(pxe, aztecNode);
  }

  private async getSponsoredPaymentMethod(): Promise<SponsoredFeePaymentMethod> {
    const { SponsoredFPCContractArtifact } = await import(
      "@aztec/noir-contracts.js/SponsoredFPC"
    );
    const instance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact,
      { salt: new Fr(SPONSORED_FPC_SALT) }
    );
    return new SponsoredFeePaymentMethod(instance.address);
  }

  protected override async completeFeeOptions(
    from: AztecAddress,
    feePayer?: AztecAddress,
    gasSettings?: Partial<FieldsOf<GasSettings>>,
  ): Promise<FeeOptions> {
    const base = await super.completeFeeOptions(from, feePayer, gasSettings);
    // Only inject sponsored FPC when the transaction doesn't already have a fee
    // payer (feePayer is set when the execution payload already embeds fee calls)
    if (!base.walletFeePaymentMethod && !feePayer) {
      base.walletFeePaymentMethod = await this.getSponsoredPaymentMethod();
    }
    return base;
  }

  getConnectedAccount() {
    return this.connectedAccount;
  }

  private async registerAccount(accountManager: AccountManager) {
    const instance = await accountManager.getInstance();
    const artifact = await accountManager
      .getAccountContract()
      .getContractArtifact();
    await this.registerContract(
      instance,
      artifact,
      accountManager.getSecretKey()
    );
  }

  async createAccountAndConnect() {
    if (!this.pxe) {
      throw new Error("PXE not initialized");
    }

    const salt = Fr.random();
    const secretKey = Fr.random();
    const signingKey = GrumpkinScalar.random();

    const contract = new SchnorrAccountContract(signingKey);
    const accountManager = await AccountManager.create(
      this,
      secretKey,
      contract,
      salt
    );

    // Register the account BEFORE deploying — the deploy tx flow calls
    // wallet.createAuthWit(accountAddress, ...) which needs getAccountFromAddress()
    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );

    const deployMethod = await accountManager.getDeployMethod();
    const paymentMethod = await this.getSponsoredPaymentMethod();
    const deployOpts: DeployAccountOptions = {
      from: AztecAddress.ZERO,
      fee: { paymentMethod },
      skipClassPublication: true,
      skipInstancePublication: true,
    };

    const receipt = await deployMethod.send(deployOpts).wait({ timeout: 120 });
    logger.info("Account deployed", receipt);

    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify({
        address: accountManager.address.toString(),
        signingKey: signingKey.toString(),
        secretKey: secretKey.toString(),
        salt: salt.toString(),
      })
    );

    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  async connectExistingAccount() {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!stored) return null;

    try {
      const parsed = JSON.parse(stored);
      const contract = new SchnorrAccountContract(
        GrumpkinScalar.fromString(parsed.signingKey)
      );
      const accountManager = await AccountManager.create(
        this,
        Fr.fromString(parsed.secretKey),
        contract,
        Fr.fromString(parsed.salt)
      );

      // Register the account early — wallet methods (createAuthWit, sendTx)
      // call getAccountFromAddress() which needs the account in the map
      await this.registerAccount(accountManager);
      this.accounts.set(
        accountManager.address.toString(),
        await accountManager.getAccount()
      );

      // Check if the account actually exists on-chain (sandbox may have restarted)
      const metadata = await this.getContractMetadata(accountManager.address);
      if (!metadata.isContractInitialized) {
        logger.warn("Saved account not found on-chain, clearing stale credentials");
        this.accounts.delete(accountManager.address.toString());
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        return null;
      }

      this.connectedAccount = accountManager.address;
      return this.connectedAccount;
    } catch (err) {
      logger.warn("Failed to restore saved account, clearing", err);
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      return null;
    }
  }

  disconnect() {
    this.connectedAccount = null;
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }

  static clearSavedAccount() {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }
}
