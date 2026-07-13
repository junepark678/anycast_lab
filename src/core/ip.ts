import type { IpFamily } from './types';

export interface ParsedIpAddress {
  family: IpFamily;
  value: bigint;
  bits: 32 | 128;
  canonical: string;
}

export interface ParsedPrefix extends ParsedIpAddress {
  prefixLength: number;
  networkValue: bigint;
  network: string;
}

export class IpParseError extends Error {
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message);
    this.name = 'IpParseError';
  }
}

function parseIpv4Value(input: string): bigint {
  const parts = input.split('.');
  if (parts.length !== 4) {
    throw new IpParseError(`Invalid IPv4 address: ${input}`, input);
  }

  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new IpParseError(`Invalid IPv4 octet in ${input}`, input);
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      throw new IpParseError(`IPv4 octet is outside 0-255 in ${input}`, input);
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn))
    .join('.');
}

function expandIpv4Tail(input: string): string {
  const lastColon = input.lastIndexOf(':');
  const tail = lastColon >= 0 ? input.slice(lastColon + 1) : input;
  if (!tail.includes('.')) return input;

  const ipv4 = parseIpv4Value(tail);
  const high = ((ipv4 >> 16n) & 0xffffn).toString(16);
  const low = (ipv4 & 0xffffn).toString(16);
  return `${input.slice(0, lastColon + 1)}${high}:${low}`;
}

function parseIpv6Groups(input: string): number[] {
  const expandedInput = expandIpv4Tail(input.toLowerCase());
  if (!/^[0-9a-f:]+$/.test(expandedInput)) {
    throw new IpParseError(`Invalid character in IPv6 address: ${input}`, input);
  }
  if ((expandedInput.match(/::/g) ?? []).length > 1) {
    throw new IpParseError(`IPv6 address contains more than one '::': ${input}`, input);
  }

  const hasCompression = expandedInput.includes('::');
  const [leftText = '', rightText = ''] = hasCompression
    ? expandedInput.split('::')
    : [expandedInput, ''];
  const left = leftText === '' ? [] : leftText.split(':');
  const right = rightText === '' ? [] : rightText.split(':');

  if ([...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    throw new IpParseError(`Invalid IPv6 group in ${input}`, input);
  }

  const explicitCount = left.length + right.length;
  if ((!hasCompression && explicitCount !== 8) || (hasCompression && explicitCount >= 8)) {
    throw new IpParseError(`IPv6 address has the wrong number of groups: ${input}`, input);
  }

  const zeroCount = hasCompression ? 8 - explicitCount : 0;
  return [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array<number>(zeroCount).fill(0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];
}

function parseIpv6Value(input: string): bigint {
  let value = 0n;
  for (const group of parseIpv6Groups(input)) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

function formatIpv6(value: bigint): string {
  const groups: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const shift = BigInt((7 - index) * 16);
    groups.push(Number((value >> shift) & 0xffffn));
  }

  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; start += 1) {
    if (groups[start] !== 0) continue;
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    const length = end - start;
    if (length > bestLength && length >= 2) {
      bestStart = start;
      bestLength = length;
    }
    start = end - 1;
  }

  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(':');
  const left = groups.slice(0, bestStart).map((group) => group.toString(16)).join(':');
  const right = groups
    .slice(bestStart + bestLength)
    .map((group) => group.toString(16))
    .join(':');
  if (left === '' && right === '') return '::';
  if (left === '') return `::${right}`;
  if (right === '') return `${left}::`;
  return `${left}::${right}`;
}

export function parseIp(input: string): ParsedIpAddress {
  const trimmed = input.trim();
  if (trimmed.includes('/')) {
    throw new IpParseError(`Expected an address without a prefix length: ${input}`, input);
  }
  const withoutZone = trimmed.replace(/%[^%]+$/, '');
  if (withoutZone.includes(':')) {
    const value = parseIpv6Value(withoutZone);
    return { family: 'ipv6', value, bits: 128, canonical: formatIpv6(value) };
  }
  const value = parseIpv4Value(withoutZone);
  return { family: 'ipv4', value, bits: 32, canonical: formatIpv4(value) };
}

function prefixMask(bits: 32 | 128, length: number): bigint {
  if (length === 0) return 0n;
  const all = (1n << BigInt(bits)) - 1n;
  return (all << BigInt(bits - length)) & all;
}

export function parsePrefix(input: string): ParsedPrefix {
  const trimmed = input.trim();
  const slash = trimmed.lastIndexOf('/');
  const addressText = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const address = parseIp(addressText);
  const prefixLengthText = slash >= 0 ? trimmed.slice(slash + 1) : undefined;
  if (prefixLengthText !== undefined && !/^\d+$/.test(prefixLengthText)) {
    throw new IpParseError(`Invalid prefix length in ${input}`, input);
  }
  const prefixLength = prefixLengthText === undefined ? address.bits : Number(prefixLengthText);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > address.bits) {
    throw new IpParseError(`Invalid prefix length in ${input}`, input);
  }
  const networkValue = address.value & prefixMask(address.bits, prefixLength);
  const formatted =
    address.family === 'ipv4' ? formatIpv4(networkValue) : formatIpv6(networkValue);
  return {
    ...address,
    prefixLength,
    networkValue,
    network: `${formatted}/${prefixLength}`,
  };
}

export function familyOf(input: string): IpFamily {
  return (input.includes('/') ? parsePrefix(input) : parseIp(input)).family;
}

export function hostAddress(input: string): string {
  return parsePrefix(input).canonical;
}

export function normalizePrefix(input: string): string {
  return parsePrefix(input).network;
}

export function addressInPrefix(address: string, prefix: string): boolean {
  const parsedAddress = parseIp(address);
  const parsedPrefix = parsePrefix(prefix);
  if (parsedAddress.family !== parsedPrefix.family) return false;
  return (
    (parsedAddress.value & prefixMask(parsedAddress.bits, parsedPrefix.prefixLength)) ===
    parsedPrefix.networkValue
  );
}

export function prefixesOverlap(first: string, second: string): boolean {
  const a = parsePrefix(first);
  const b = parsePrefix(second);
  if (a.family !== b.family) return false;
  const shorter = a.prefixLength <= b.prefixLength ? a : b;
  const longer = shorter === a ? b : a;
  return (
    (longer.networkValue & prefixMask(longer.bits, shorter.prefixLength)) ===
    shorter.networkValue
  );
}

export function isUsableHostInPrefix(address: string, prefix: string): boolean {
  return addressInPrefix(address, prefix);
}

export function compareIp(first: string, second: string): number {
  const a = parseIp(first);
  const b = parseIp(second);
  if (a.family !== b.family) return a.family === 'ipv4' ? -1 : 1;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

export function prefixLength(prefix: string): number {
  return parsePrefix(prefix).prefixLength;
}

export function tryParseIp(input: string): ParsedIpAddress | undefined {
  try {
    return parseIp(input);
  } catch {
    return undefined;
  }
}

export function tryParsePrefix(input: string): ParsedPrefix | undefined {
  try {
    return parsePrefix(input);
  } catch {
    return undefined;
  }
}
