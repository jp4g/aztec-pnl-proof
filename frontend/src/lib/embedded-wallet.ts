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
const ACCOUNTS_KEY = "privdex-aztec-accounts";
const ACTIVE_ACCOUNT_KEY = "privdex-aztec-active-account";
const LEGACY_KEY = "privdex-aztec-account";
const REGISTERED_CONTRACTS_KEY = "privdex-registered-contracts";

interface ContractRegistryEntry {
  label: string;
  address: string | undefined;
  loadArtifact: () => Promise<import("@aztec/aztec.js/abi").ContractArtifact>;
}

// Next.js requires static process.env.NEXT_PUBLIC_* access for build-time replacement
const CONTRACT_REGISTRY: ContractRegistryEntry[] = [
  {
    label: "Token (USDC)",
    address: process.env.NEXT_PUBLIC_TOKEN_USDC,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
  {
    label: "Token (wETH)",
    address: process.env.NEXT_PUBLIC_TOKEN_WETH,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
  {
    label: "Token (wZEC)",
    address: process.env.NEXT_PUBLIC_TOKEN_WZEC,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
  {
    label: "Token (wAZTEC)",
    address: process.env.NEXT_PUBLIC_TOKEN_WAZTEC,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
  {
    label: "PriceFeed",
    address: process.env.NEXT_PUBLIC_PRICE_FEED,
    loadArtifact: () => import("@aztec/noir-contracts.js/PriceFeed").then((m) => m.PriceFeedContractArtifact),
  },
  {
    label: "AMM (ETH/USDC)",
    address: process.env.NEXT_PUBLIC_AMM_ETH_USDC,
    loadArtifact: () => import("../artifacts/AMM").then((m) => m.AMMContractArtifact),
  },
  {
    label: "AMM (ZEC/USDC)",
    address: process.env.NEXT_PUBLIC_AMM_ZEC_USDC,
    loadArtifact: () => import("../artifacts/AMM").then((m) => m.AMMContractArtifact),
  },
  {
    label: "AMM (AZTEC/USDC)",
    address: process.env.NEXT_PUBLIC_AMM_AZTEC_USDC,
    loadArtifact: () => import("../artifacts/AMM").then((m) => m.AMMContractArtifact),
  },
  {
    label: "LP (ETH/USDC)",
    address: process.env.NEXT_PUBLIC_LP_ETH_USDC,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
  {
    label: "LP (ZEC/USDC)",
    address: process.env.NEXT_PUBLIC_LP_ZEC_USDC,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
  {
    label: "LP (AZTEC/USDC)",
    address: process.env.NEXT_PUBLIC_LP_AZTEC_USDC,
    loadArtifact: () => import("../artifacts/Token").then((m) => m.TokenContractArtifact),
  },
];

interface StoredAccount {
  address: string;
  signingKey: string;
  secretKey: string;
  salt: string;
}

function loadStoredAccounts(): StoredAccount[] {
  // Migrate legacy single-account key if present
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy) as StoredAccount;
      const arr = [parsed];
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(arr));
      localStorage.setItem(ACTIVE_ACCOUNT_KEY, parsed.address);
      localStorage.removeItem(LEGACY_KEY);
      return arr;
    } catch {
      localStorage.removeItem(LEGACY_KEY);
    }
  }
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as StoredAccount[];
  } catch {
    return [];
  }
}

function saveStoredAccounts(accounts: StoredAccount[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

function getStoredActiveAddress(): string | null {
  return localStorage.getItem(ACTIVE_ACCOUNT_KEY);
}

function setStoredActiveAddress(address: string) {
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, address);
}

function loadRegisteredContracts(): string[] {
  const raw = localStorage.getItem(REGISTERED_CONTRACTS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

function saveRegisteredContracts(addresses: string[]) {
  localStorage.setItem(REGISTERED_CONTRACTS_KEY, JSON.stringify(addresses));
}


export class EmbeddedAuditableWallet extends AuditableWallet {
  connectedAccount: AztecAddress | null = null;
  protected accounts: Map<string, Account> = new Map();
  private internalAccounts = new Set<string>();

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

        await this.registerAccount(accountManager);
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
    // Check if cached registrations match the current env addresses.
    // If they don't (new deployment), wipe the cache and re-register everything.
    const expectedAddrs = CONTRACT_REGISTRY
      .map((e) => e.address)
      .filter((a): a is string => !!a)
      .sort();
    const cachedAddrs = loadRegisteredContracts().sort();
    const cacheValid =
      expectedAddrs.length === cachedAddrs.length &&
      expectedAddrs.every((a, i) => a === cachedAddrs[i]);

    if (cacheValid) {
      logger.info("[register] cache matches env, skipping registration");
      return;
    }

    // Cache is stale or empty — wipe and re-register
    saveRegisteredContracts([]);
    const registeredSet = new Set<string>();

    for (const entry of CONTRACT_REGISTRY) {
      const addrStr = entry.address;
      if (!addrStr) {
        logger.info(`[register] skip ${entry.label}: no env var`);
        continue;
      }

      try {
        const address = AztecAddress.fromString(addrStr);
        const instance = await this.aztecNode.getContract(address);
        if (!instance) {
          logger.info(`[register] skip ${entry.label}: not found on-chain`);
          continue;
        }

        const artifact = await entry.loadArtifact();
        await this.registerContract(instance, artifact);
        registeredSet.add(addrStr);
        logger.info(`[register] registered ${entry.label} at ${addrStr}`);
      } catch (err) {
        logger.warn(`[register] failed ${entry.label}:`, err);
      }
    }

    saveRegisteredContracts([...registeredSet]);
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

  disconnect() {
    this.connectedAccount = null;
  }

  removeAccount(address: AztecAddress) {
    const key = address.toString();
    this.accounts.delete(key);

    const stored = loadStoredAccounts().filter(e => e.address !== key);
    saveStoredAccounts(stored);

    if (this.connectedAccount?.toString() === key) {
      const next = stored.length > 0 ? AztecAddress.fromString(stored[0].address) : null;
      this.connectedAccount = next;
      if (next) {
        setStoredActiveAddress(next.toString());
      } else {
        localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
      }
    }
  }

  static clearAllSavedAccounts() {
    localStorage.removeItem(ACCOUNTS_KEY);
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(REGISTERED_CONTRACTS_KEY);
  }
}
