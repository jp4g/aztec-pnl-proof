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
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr/lazy";

import { getPXEConfig } from "@aztec/pxe/config";
import { createPXE } from "@aztec/pxe/client/lazy";

const logger = createLogger("privdex:wallet");
const LOCAL_STORAGE_KEY = "privdex-aztec-account";

export class EmbeddedWallet extends BaseWallet {
  connectedAccount: AztecAddress | null = null;
  protected accounts: Map<string, Account> = new Map();

  protected async getAccountFromAddress(
    address: AztecAddress
  ): Promise<Account> {
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
    config.l1Contracts = await aztecNode.getL1ContractAddresses();
    config.proverEnabled = true;
    const pxe = await createPXE(aztecNode, config, { useLogSuffix: true });

    await pxe.registerContract(await EmbeddedWallet.getSponsoredFPC());

    const nodeInfo = await aztecNode.getNodeInfo();
    logger.info("PXE connected to node", nodeInfo);
    return new EmbeddedWallet(pxe, aztecNode);
  }

  private static async getSponsoredFPC() {
    const { SponsoredFPCContractArtifact } = await import(
      "@aztec/noir-contracts.js/SponsoredFPC"
    );
    const instance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact,
      { salt: new Fr(SPONSORED_FPC_SALT) }
    );
    return { instance, artifact: SponsoredFPCContractArtifact };
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

    const deployMethod = await accountManager.getDeployMethod();
    const sponsoredFPC = await EmbeddedWallet.getSponsoredFPC();
    const deployOpts: DeployAccountOptions = {
      from: AztecAddress.ZERO,
      fee: {
        paymentMethod: new SponsoredFeePaymentMethod(
          sponsoredFPC.instance.address
        ),
      },
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

    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );
    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  async connectExistingAccount() {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!stored) return null;

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

    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );
    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  disconnect() {
    this.connectedAccount = null;
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  }
}
