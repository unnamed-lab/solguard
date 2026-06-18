export function formatNumber(val: number): string {
  return new Intl.NumberFormat().format(val);
}

export function formatLamports(lamports: number): string {
  if (lamports >= 1_000_000_000) {
    return `${(lamports / 1_000_000_000).toFixed(4)} SOL`;
  }
  return `${formatNumber(lamports)} lamports`;
}

export function formatSlot(slot: number): string {
  return formatNumber(slot);
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '-';
  return `${ms}ms`;
}

export function shortenSignature(sig: string): string {
  if (!sig) return '';
  if (sig.length <= 16) return sig;
  return `${sig.substring(0, 8)}...${sig.substring(sig.length - 8)}`;
}

export function shortenAddress(address: string): string {
  if (!address) return '';
  if (address.length <= 8) return address;
  return `${address.substring(0, 4)}...${address.substring(address.length - 4)}`;
}

export function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + 
           '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return isoString;
  }
}
