import { Account, NO_FROM } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { Fr } from "@aztec/aztec.js/fields";
import { createLogger } from "@aztec/aztec.js/log";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import {
  AccountManager,
  type DeployAccountOptions,
  ContractInitializationStatus,
} from "@aztec/aztec.js/wallet";
import { GrumpkinScalar } from "@aztec/foundation/curves/grumpkin";
import { SchnorrAccountContract } from "@aztec/accounts/schnorr/lazy";
import { createPXE, type ExportedTaggingSecret } from "@aztec/pxe/client/lazy";
import { getPXEConfig } from "@aztec/pxe/config";
import { BaseWallet, type CompleteFeeOptionsConfig, type FeeOptions } from "@aztec/wallet-sdk/base-wallet";

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
    import("@privpnl/contracts/PriceFeed").then((m) => m.PriceFeedContractArtifact),
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
    // Set dataDirectory so the IDB store gets a stable name across page reloads.
    // Without this, AztecIndexedDBStore.open receives '' which is falsy, causing
    // it to generate a random DB name every time (data lost on refresh).
    config.dataDirectory = 'aztec-pnl-proof';
    const pxe = await createPXE(aztecNode, config, {});

    // Register sponsored FPC using address from env (skip if already in PXE)
    const fpcAddr = process.env.NEXT_PUBLIC_SPONSORED_FPC_ADDRESS;
    if (!fpcAddr) {
      throw new Error('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS is required. Run `yarn deploy` or `yarn fpc:deploy` first.');
    }

    const registered = await pxe.getContracts();
    const fpcAztecAddr = AztecAddress.fromString(fpcAddr);
    const fpcAlreadyRegistered = registered.some(a => a.equals(fpcAztecAddr));

    if (!fpcAlreadyRegistered) {
      const { SponsoredFPCContractArtifact } = await import(
        "@aztec/noir-contracts.js/SponsoredFPC"
      );
      const { getContractInstanceFromInstantiationParams } = await import(
        "@aztec/aztec.js/contracts"
      );
      const { SPONSORED_FPC_SALT } = await import("@aztec/constants");
      const fpcInstance = await getContractInstanceFromInstantiationParams(
        SponsoredFPCContractArtifact,
        { salt: new Fr(SPONSORED_FPC_SALT) }
      );
      await pxe.registerContract({
        instance: fpcInstance,
        artifact: SponsoredFPCContractArtifact,
      });
      logger.info("[init] registered SponsoredFPC");
    } else {
      logger.info("[init] SponsoredFPC already registered, skipping");
    }

    const nodeInfo = await aztecNode.getNodeInfo();
    logger.info("PXE connected to node", nodeInfo);
    return new EmbeddedAuditableWallet(pxe as any, aztecNode);
  }

  private async getSponsoredPaymentMethod(): Promise<SponsoredFeePaymentMethod> {
    const fpcAddr = process.env.NEXT_PUBLIC_SPONSORED_FPC_ADDRESS;
    if (!fpcAddr) {
      throw new Error('NEXT_PUBLIC_SPONSORED_FPC_ADDRESS is required');
    }
    return new SponsoredFeePaymentMethod(AztecAddress.fromString(fpcAddr));
  }

  protected override async completeFeeOptions(config: CompleteFeeOptionsConfig): Promise<FeeOptions> {
    const base = await super.completeFeeOptions(config);
    const { from, feePayer } = config;
    // Only inject sponsored FPC when the transaction doesn't already have a fee
    // payer (feePayer is set when the execution payload already embeds fee calls)
    // and the sender is not an internal account (e.g. admin pays its own gas)
    if (from !== NO_FROM && !base.walletFeePaymentMethod && !feePayer && !this.internalAccounts.has(from.toString())) {
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
      from: NO_FROM,
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

    // Check which accounts are already registered in PXE (local IDB, fast)
    const registered = await this.pxe.getContracts();
    const registeredSet = new Set(registered.map(a => a.toString()));

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

        // Skip PXE registration if account is already persisted from a prior session
        if (!registeredSet.has(accountManager.address.toString())) {
          await this.enqueue(() => this.registerAccount(accountManager));
          logger.info(`[accounts] registered ${entry.address}`);
        } else {
          logger.info(`[accounts] ${entry.address} already registered, skipping`);
        }
        this.accounts.set(
          accountManager.address.toString(),
          await accountManager.getAccount()
        );

        // Check if the account actually exists on-chain (sandbox may have restarted)
        const metadata = await this.getContractMetadata(accountManager.address);
        if (metadata.initializationStatus !== ContractInitializationStatus.INITIALIZED) {
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

    // Check which contracts are already registered in PXE (local IDB read, fast)
    const registered = await this.pxe.getContracts();
    const registeredSet = new Set(registered.map(a => a.toString()));

    const missing = entries.filter(e => !registeredSet.has(AztecAddress.fromString(e.address!).toString()));
    if (missing.length === 0) {
      logger.info(`[register] all ${entries.length} contracts already registered, skipping`);
      return;
    }
    logger.info(`[register] ${entries.length - missing.length} already registered, registering ${missing.length} missing`);

    // Only fetch + register the missing contracts
    const resolved = await Promise.all(
      missing.map(async (entry) => {
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
  ): Promise<ExportedTaggingSecret[]> {
    return (this.pxe as any).exportTaggingSecrets(account, apps, counterparties);
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
