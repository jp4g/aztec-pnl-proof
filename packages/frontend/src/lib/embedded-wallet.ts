import { Account } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { createLogger } from "@aztec/aztec.js/log";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  AccountManager,
  type DeployAccountOptions,
} from "@aztec/aztec.js/wallet";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import type { FieldsOf } from "@aztec/foundation/types";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr/lazy";
import { createPXE, type TaggingSecretExport } from "@aztec/pxe/client/lazy";
import { getPXEConfig } from "@aztec/pxe/config";
import { BaseWallet, type FeeOptions } from "@aztec/wallet-sdk/base-wallet";
import { GasSettings } from "@aztec/stdlib/gas";

import {
  TOKEN_ADDRESSES,
  POOL_ADDRESSES,
  LP_ADDRESSES,
  PRICE_FEED_ADDRESS,
} from "@/config/contracts";
import {
  type StoredAccount,
  loadStoredAccounts,
  saveStoredAccounts,
  getStoredActiveAddress,
  setStoredActiveAddress,
  removeStoredActiveAddress,
  clearAllStoredAccounts,
} from "@/lib/storage";

const logger = createLogger("privpnl:wallet");

interface ContractRegistryEntry {
  label: string;
  address: string | undefined;
  loadArtifact: () => Promise<import("@aztec/aztec.js/abi").ContractArtifact>;
}

const loadTokenArtifact = () =>
  import("@aztec/noir-contracts.js/Token").then((m) => m.TokenContractArtifact);
const loadAMMArtifact = () =>
  import("@privpnl/contracts/AMM").then((m) => m.AMMContractArtifact);

// Build CONTRACT_REGISTRY from config data instead of manual repetition
const TOKEN_NAMES = ["USDC", "wETH", "wZEC", "wAZTEC"] as const;
const POOL_KEYS = ["ETH/USDC", "ZEC/USDC", "AZTEC/USDC"] as const;

const tokenEntries: ContractRegistryEntry[] = TOKEN_NAMES.map((name) => ({
  label: `Token (${name})`,
  address: TOKEN_ADDRESSES[name],
  loadArtifact: loadTokenArtifact,
}));

const priceFeedEntry: ContractRegistryEntry = {
  label: "PriceFeed",
  address: PRICE_FEED_ADDRESS,
  loadArtifact: () =>
    import("@aztec/noir-contracts.js/PriceFeed").then((m) => m.PriceFeedContractArtifact),
};

const ammEntries: ContractRegistryEntry[] = POOL_KEYS.map((key) => ({
  label: `AMM (${key})`,
  address: POOL_ADDRESSES[`w${key}`],
  loadArtifact: loadAMMArtifact,
}));

const lpEntries: ContractRegistryEntry[] = POOL_KEYS.map((key) => ({
  label: `LP (${key})`,
  address: LP_ADDRESSES[key],
  loadArtifact: loadTokenArtifact,
}));

const CONTRACT_REGISTRY: ContractRegistryEntry[] = [
  ...tokenEntries,
  priceFeedEntry,
  ...ammEntries,
  ...lpEntries,
];

// Deploy script writes NEXT_PUBLIC_DEMO_ACCOUNTS for both devnet and sandbox.
const DEMO_ACCOUNTS: StoredAccount[] = process.env.NEXT_PUBLIC_DEMO_ACCOUNTS
  ? (JSON.parse(process.env.NEXT_PUBLIC_DEMO_ACCOUNTS) as StoredAccount[]).map(a => ({ ...a, isDemo: true }))
  : [];



export class EmbeddedAuditableWallet extends BaseWallet {
  connectedAccount: AztecAddress | null = null;
  protected accounts: Map<string, Account> = new Map();
  private internalAccounts = new Set<string>();
  /** Serializes all PXE/IDB operations to avoid TransactionInactiveError */
  private idbQueue: Promise<unknown> = Promise.resolve();

  /** Queue a PXE operation that touches IDB so it doesn't overlap with others */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.idbQueue.then(fn, fn);
    this.idbQueue = p.catch(() => {});
    return p;
  }

  protected async getAccountFromAddress(
    address: AztecAddress
  ): Promise<Account> {
    if (address.equals(AztecAddress.ZERO)) {
      const { SignerlessAccount } = await import("@aztec/aztec.js/account");
      return new SignerlessAccount();
    }
    const account = this.accounts.get(address?.toString() ?? "");
    if (!account) {
      throw new Error(`Account not found for address: ${address}`);
    }
    return account;
  }

  getAccounts() {
    return Promise.resolve(
      Array.from(this.accounts.values())
        .filter((acc) => !this.internalAccounts.has(acc.getAddress().toString()))
        .map((acc) => ({
          alias: "",
          item: acc.getAddress(),
        }))
    );
  }

  static async initialize(nodeUrl: string) {
    const aztecNode = createAztecNodeClient(nodeUrl);

    const config = getPXEConfig();
    config.proverEnabled = true;
    const pxe = await createPXE(aztecNode, config, {});

    // Register sponsored FPC using address from env
    const fpcAddr = process.env.NEXT_PUBLIC_SPONSORED_FPC_ADDRESS;
    if (!fpcAddr) {
      throw new Error('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS is required. Run `yarn deploy` or `yarn fpc:deploy` first.');
    }
    const fpcAddress = AztecAddress.fromString(fpcAddr);
    const { SponsoredFPCContractArtifact } = await import(
      "@aztec/noir-contracts.js/SponsoredFPC"
    );
    const fpcInstance = await aztecNode.getContract(fpcAddress);
    if (!fpcInstance) {
      throw new Error(`SponsoredFPC not found on-chain at ${fpcAddress}`);
    }
    await pxe.registerContract({
      instance: fpcInstance,
      artifact: SponsoredFPCContractArtifact,
    });

    const nodeInfo = await aztecNode.getNodeInfo();
    logger.info("PXE connected to node", nodeInfo);
    return new EmbeddedAuditableWallet(pxe, aztecNode);
  }

  private async getSponsoredPaymentMethod(): Promise<SponsoredFeePaymentMethod> {
    const fpcAddr = process.env.NEXT_PUBLIC_SPONSORED_FPC_ADDRESS;
    if (!fpcAddr) {
      throw new Error('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS is required');
    }
    return new SponsoredFeePaymentMethod(AztecAddress.fromString(fpcAddr));
  }

  protected override async completeFeeOptions(
    from: AztecAddress,
    feePayer?: AztecAddress,
    gasSettings?: Partial<FieldsOf<GasSettings>>,
  ): Promise<FeeOptions> {
    const base = await super.completeFeeOptions(from, feePayer, gasSettings);
    // Only inject sponsored FPC when the transaction doesn't already have a fee
    // payer (feePayer is set when the execution payload already embeds fee calls)
    // and the sender is not an internal account (e.g. admin pays its own gas)
    if (!base.walletFeePaymentMethod && !feePayer && !this.internalAccounts.has(from.toString())) {
      base.walletFeePaymentMethod = await this.getSponsoredPaymentMethod();
      // Tell the account entrypoint that fees are handled externally (by the FPC),
      // so it doesn't also try to set up fee juice payment itself.
      // AccountFeePaymentMethodOptions.EXTERNAL = 0
      base.accountFeePaymentMethodOptions = 0;
    }
    return base;
  }

  getConnectedAccount() {
    return this.connectedAccount;
  }

  /** Public accessor for the Aztec node client */
  getNode() {
    return this.aztecNode;
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

    const receipt = await deployMethod.send(deployOpts);
    logger.info("Account deployed", receipt);

    const newEntry: StoredAccount = {
      address: accountManager.address.toString(),
      signingKey: signingKey.toString(),
      secretKey: secretKey.toString(),
      salt: salt.toString(),
    };
    const existing = loadStoredAccounts();
    existing.push(newEntry);
    saveStoredAccounts(existing);
    setStoredActiveAddress(newEntry.address);

    this.connectedAccount = accountManager.address;
    return this.connectedAccount;
  }

  async connectAllAccounts(): Promise<{ active: AztecAddress | null; all: AztecAddress[] }> {
    const stored = loadStoredAccounts();
    for (const demo of DEMO_ACCOUNTS) {
      if (!stored.some(e => e.address === demo.address)) {
        stored.push(demo);
      }
    }
    if (stored.length === 0) return { active: null, all: [] };

    const validAddresses: AztecAddress[] = [];
    const validEntries: StoredAccount[] = [];

    for (const entry of stored) {
      try {
        const contract = new SchnorrAccountContract(
          GrumpkinScalar.fromString(entry.signingKey)
        );
        const accountManager = await AccountManager.create(
          this,
          Fr.fromString(entry.secretKey),
          contract,
          Fr.fromString(entry.salt)
        );

        await this.enqueue(() => this.registerAccount(accountManager));
        this.accounts.set(
          accountManager.address.toString(),
          await accountManager.getAccount()
        );

        // Check if the account actually exists on-chain (sandbox may have restarted)
        const metadata = await this.getContractMetadata(accountManager.address);
        if (!metadata.isContractInitialized) {
          logger.warn("Account not found on-chain, removing stale entry", entry.address);
          this.accounts.delete(accountManager.address.toString());
          continue;
        }

        validAddresses.push(accountManager.address);
        validEntries.push(entry);
      } catch (err) {
        logger.warn(`Failed to restore account ${entry.address}, skipping: ${err}`);
      }
    }

    // Persist only valid entries
    saveStoredAccounts(validEntries);

    // Determine active account
    const storedActive = getStoredActiveAddress();
    const activeAddr = validAddresses.find(a => a.toString() === storedActive) ?? validAddresses[0] ?? null;

    if (activeAddr) {
      this.connectedAccount = activeAddr;
      setStoredActiveAddress(activeAddr.toString());
    }

    return { active: activeAddr, all: validAddresses };
  }

  async registerDeployedContracts(): Promise<void> {
    const entries = CONTRACT_REGISTRY.filter((e) => !!e.address);

    // Fetch all on-chain instances + artifacts in parallel (no IDB)
    const resolved = await Promise.all(
      entries.map(async (entry) => {
        try {
          const address = AztecAddress.fromString(entry.address!);
          const [instance, artifact] = await Promise.all([
            this.aztecNode.getContract(address),
            entry.loadArtifact(),
          ]);
          if (!instance) {
            logger.info(`[register] skip ${entry.label}: not found on-chain`);
            return null;
          }
          return { label: entry.label, address: entry.address!, instance, artifact };
        } catch (err) {
          logger.warn(`[register] failed to fetch ${entry.label}:`, err);
          return null;
        }
      })
    );

    // Register all contracts in a single queue item so balance fetches
    // can't interleave between them
    const items = resolved.filter((r): r is NonNullable<typeof r> => r !== null);
    if (items.length === 0) return;

    await this.enqueue(async () => {
      for (const item of items) {
        try {
          await this.registerContract(item.instance, item.artifact);
          logger.info(`[register] registered ${item.label} at ${item.address}`);
        } catch (err) {
          logger.warn(`[register] failed ${item.label}:`, err);
        }
      }
    });
  }

  async registerAccountFromCredentials(
    secret: Fr,
    salt: Fr,
    signingKey: GrumpkinScalar,
  ): Promise<AztecAddress> {
    const contract = new SchnorrAccountContract(signingKey);
    const accountManager = await AccountManager.create(this, secret, contract, salt);
    await this.registerAccount(accountManager);
    this.accounts.set(
      accountManager.address.toString(),
      await accountManager.getAccount()
    );
    this.internalAccounts.add(accountManager.address.toString());
    return accountManager.address;
  }

  getAccountAddresses(): AztecAddress[] {
    return Array.from(this.accounts.keys())
      .filter(a => !this.internalAccounts.has(a))
      .map(a => AztecAddress.fromString(a));
  }

  switchAccount(address: AztecAddress) {
    const key = address.toString();
    if (!this.accounts.has(key)) {
      throw new Error(`Account not found: ${key}`);
    }
    this.connectedAccount = address;
    setStoredActiveAddress(key);
  }

  exportTaggingSecrets(
    account: AztecAddress,
    apps: AztecAddress[],
    counterparties?: AztecAddress[],
  ): Promise<TaggingSecretExport> {
    return this.pxe.exportTaggingSecrets(account, apps, counterparties);
  }

  async getAuditProofInputs(account: AztecAddress, poolAddresses: AztecAddress[]) {
    const secrets = await this.exportTaggingSecrets(account, poolAddresses, [account]);
    const pxeAny = this.pxe as any;
    const ivskM = await pxeAny.keyStore.getMasterIncomingViewingSecretKey(account);
    const registeredAccounts = await pxeAny.getRegisteredAccounts();
    const completeAddress = registeredAccounts.find((a: any) => a.address.equals(account));
    return { secrets, ivskM, completeAddress };
  }

  isDemoAccount(address: string): boolean {
    return DEMO_ACCOUNTS.some(d => d.address === address);
  }

  disconnect() {
    this.connectedAccount = null;
  }

  removeAccount(address: AztecAddress) {
    const key = address.toString();
    if (DEMO_ACCOUNTS.some(d => d.address === key)) return; // Cannot delete demo accounts

    this.accounts.delete(key);

    const stored = loadStoredAccounts().filter(e => e.address !== key);
    saveStoredAccounts(stored);

    if (this.connectedAccount?.toString() === key) {
      const next = stored.length > 0 ? AztecAddress.fromString(stored[0].address) : null;
      this.connectedAccount = next;
      if (next) {
        setStoredActiveAddress(next.toString());
      } else {
        removeStoredActiveAddress();
      }
    }
  }

  static clearAllSavedAccounts() {
    clearAllStoredAccounts();
  }
}
