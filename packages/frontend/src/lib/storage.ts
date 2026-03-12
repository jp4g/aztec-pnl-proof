/**
 * localStorage helpers for persisting Aztec account data.
 * Extracted from embedded-wallet.ts to reduce file size.
 */

const ACCOUNTS_KEY = "privpnl-aztec-accounts";
const ACTIVE_ACCOUNT_KEY = "privpnl-aztec-active-account";
const LEGACY_KEY = "privpnl-aztec-account";

export interface StoredAccount {
  address: string;
  signingKey: string;
  secretKey: string;
  salt: string;
  isDemo?: boolean;
}

export function loadStoredAccounts(): StoredAccount[] {
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

export function saveStoredAccounts(accounts: StoredAccount[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function getStoredActiveAddress(): string | null {
  return localStorage.getItem(ACTIVE_ACCOUNT_KEY);
}

export function setStoredActiveAddress(address: string) {
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, address);
}

export function removeStoredActiveAddress() {
  localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
}

export function clearAllStoredAccounts() {
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  localStorage.removeItem(LEGACY_KEY);
}

// --- USDC minting tracking ---

const MINTED_KEY = "privpnl-usdc-minted";

export function loadMintedAddresses(): Set<string> {
  try {
    const raw = localStorage.getItem(MINTED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

export function saveMintedAddress(addr: string) {
  const set = loadMintedAddresses();
  set.add(addr);
  localStorage.setItem(MINTED_KEY, JSON.stringify([...set]));
}
