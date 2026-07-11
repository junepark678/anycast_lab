import { familyOf, normalizePrefix, tryParseIp, tryParsePrefix } from '../ip';
import type {
  ConfigDiagnostic,
  IpFamily,
  LabNode,
  ParsedApplianceConfig,
  ParsedBgpNeighbor,
  ParsedOspfArea,
  ParsedStaticRoute,
  RoutePolicyMode,
} from '../types';
import { cloneSourceFiles, expandIncludes, selectEntrypoint, type SourceFragment } from './common';

interface Token {
  value: string;
  file: string;
  line: number;
}

function lexFragment(fragment: SourceFragment, diagnostics: ConfigDiagnostic[]): Token[] {
  const tokens: Token[] = [];
  const input = fragment.content;
  let index = 0;
  let line = fragment.startLine;
  const punctuation = new Set(['{', '}', ';', '=', '[', ']', ',', '(', ')', '~']);

  while (index < input.length) {
    const char = input[index] ?? '';
    if (/\s/.test(char)) {
      if (char === '\n') line += 1;
      index += 1;
      continue;
    }
    if (char === '#' || (char === '/' && input[index + 1] === '/')) {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && input[index + 1] === '*') {
      const startLine = line;
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        if (input[index] === '\n') line += 1;
        index += 1;
      }
      if (index >= input.length) {
        diagnostics.push({
          severity: 'error',
          code: 'bird.comment-unclosed',
          file: fragment.file,
          line: startLine,
          message: 'Unterminated block comment.',
        });
      } else {
        index += 2;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const tokenLine = line;
      index += 1;
      let value = '';
      while (index < input.length && input[index] !== quote) {
        if (input[index] === '\\' && input[index + 1] !== undefined) {
          value += input[index + 1];
          index += 2;
        } else {
          if (input[index] === '\n') line += 1;
          value += input[index];
          index += 1;
        }
      }
      if (input[index] !== quote) {
        diagnostics.push({
          severity: 'error',
          code: 'bird.string-unclosed',
          file: fragment.file,
          line: tokenLine,
          message: 'Unterminated quoted string.',
        });
      } else {
        index += 1;
      }
      tokens.push({ value, file: fragment.file, line: tokenLine });
      continue;
    }
    if (punctuation.has(char)) {
      tokens.push({ value: char, file: fragment.file, line });
      index += 1;
      continue;
    }

    const tokenLine = line;
    let value = '';
    while (index < input.length) {
      const current = input[index] ?? '';
      if (/\s/.test(current) || punctuation.has(current)) break;
      if (current === '#') break;
      if (current === '/' && (input[index + 1] === '/' || input[index + 1] === '*')) break;
      value += current;
      index += 1;
    }
    if (value !== '') tokens.push({ value, file: fragment.file, line: tokenLine });
    else index += 1;
  }
  return tokens;
}

function findMatchingBrace(tokens: Token[], open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    if (tokens[index]?.value === '{') depth += 1;
    if (tokens[index]?.value === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function numeric(value: string | undefined, defines: Map<string, string>): number | undefined {
  if (!value) return undefined;
  const resolved = defines.get(value) ?? value;
  const normalized = resolved.replaceAll('_', '');
  const parsed = /^0x/i.test(normalized) ? Number.parseInt(normalized.slice(2), 16) : Number(normalized);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function resolved(value: string | undefined, defines: Map<string, string>): string | undefined {
  if (!value) return undefined;
  return defines.get(value) ?? value;
}

function extractPolicy(
  block: Token[],
  direction: 'import' | 'export',
  defines: Map<string, string>,
): { mode: RoutePolicyMode; prefixes?: string[] } {
  const directionIndex = block.findIndex((token) => token.value.toLowerCase() === direction);
  if (directionIndex < 0) return { mode: direction === 'import' ? 'all' : 'none' };
  const next = block[directionIndex + 1]?.value.toLowerCase();
  if (next === 'all') return { mode: 'all' };
  if (next === 'none') return { mode: 'none' };

  const prefixes = new Set<string>();
  for (let index = directionIndex + 1; index < block.length; index += 1) {
    const value = resolved(block[index]?.value, defines);
    if (value && tryParsePrefix(value)) prefixes.add(normalizePrefix(value));
  }
  return { mode: 'configured', prefixes: [...prefixes] };
}

function channelBlock(tokens: Token[], family: IpFamily): Token[] | undefined {
  const target = family === 'ipv4' ? 'ipv4' : 'ipv6';
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value.toLowerCase() !== target) continue;
    const open = tokens.findIndex((token, candidate) => candidate > index && token.value === '{');
    if (open < 0) continue;
    const close = findMatchingBrace(tokens, open);
    if (close !== undefined) return tokens.slice(open + 1, close);
  }
  return undefined;
}

function parseStaticBlock(tokens: Token[], defines: Map<string, string>): ParsedStaticRoute[] {
  const routes: ParsedStaticRoute[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value.toLowerCase() !== 'route') continue;
    const prefixText = resolved(tokens[index + 1]?.value, defines);
    if (!prefixText || !tryParsePrefix(prefixText)) continue;
    const statementEnd = tokens.findIndex((token, candidate) => candidate > index && token.value === ';');
    const end = statementEnd < 0 ? tokens.length : statementEnd;
    const statement = tokens.slice(index + 2, end).map((token) => resolved(token.value, defines) ?? token.value);
    const viaIndex = statement.findIndex((value) => value.toLowerCase() === 'via');
    const devIndex = statement.findIndex((value) => value.toLowerCase() === 'dev');
    const dispositionToken = statement.find((value) =>
      ['blackhole', 'unreachable', 'prohibit'].includes(value.toLowerCase()),
    );
    routes.push({
      prefix: normalizePrefix(prefixText),
      nextHop: viaIndex >= 0 && tryParseIp(statement[viaIndex + 1] ?? '') ? statement[viaIndex + 1] : undefined,
      interfaceName: devIndex >= 0 ? statement[devIndex + 1] : undefined,
      disposition: dispositionToken
        ? (dispositionToken.toLowerCase() as 'blackhole' | 'unreachable' | 'prohibit')
        : 'forward',
    });
    index = end;
  }
  return routes;
}

export function parseBirdConfig(node: LabNode): ParsedApplianceConfig {
  const diagnostics: ConfigDiagnostic[] = [];
  const result: ParsedApplianceConfig = {
    daemon: 'bird',
    interfaces: [],
    staticRoutes: [],
    bgp: [],
    ospf: [],
    diagnostics,
    sourceFiles: cloneSourceFiles(node.files),
  };
  const entrypoint = selectEntrypoint(node, ['/etc/bird/bird.conf', '/etc/bird.conf']);
  if (!entrypoint) {
    diagnostics.push({
      severity: 'error',
      code: 'bird.config-missing',
      message: 'No BIRD configuration file was supplied.',
    });
    return result;
  }

  const tokens = expandIncludes(node.files, entrypoint, diagnostics).flatMap((fragment) =>
    lexFragment(fragment, diagnostics),
  );
  const defines = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = tokens[index]?.value.toLowerCase();
    if (keyword === 'define' && tokens[index + 2]?.value === '=') {
      const name = tokens[index + 1]?.value;
      const value = tokens[index + 3]?.value;
      if (name && value) defines.set(name, value);
    }
    if (keyword === 'router' && tokens[index + 1]?.value.toLowerCase() === 'id') {
      const value = resolved(tokens[index + 2]?.value, defines);
      if (value && tryParseIp(value)?.family === 'ipv4') result.routerId = value;
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value.toLowerCase() !== 'protocol') continue;
    const type = tokens[index + 1]?.value.toLowerCase();
    if (!type) continue;
    let cursor = index + 2;
    let variant: string | undefined;
    if ((type === 'ospf' || type === 'rip') && /^v\d$/i.test(tokens[cursor]?.value ?? '')) {
      variant = tokens[cursor]?.value.toLowerCase();
      cursor += 1;
    }
    let name = type;
    if (tokens[cursor]?.value && !['from', '{', ';'].includes(tokens[cursor]!.value.toLowerCase())) {
      name = tokens[cursor]!.value;
      cursor += 1;
    }
    const open = tokens.findIndex((token, candidate) => candidate >= cursor && token.value === '{');
    if (open < 0) continue;
    const close = findMatchingBrace(tokens, open);
    if (close === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'bird.block-unclosed',
        file: tokens[open]?.file,
        line: tokens[open]?.line,
        message: `Protocol ${name} has an unterminated block.`,
      });
      break;
    }
    const block = tokens.slice(open + 1, close);

    if (type === 'static') {
      result.staticRoutes.push(...parseStaticBlock(block, defines));
    } else if (type === 'bgp') {
      const localIndex = block.findIndex((token) => token.value.toLowerCase() === 'local');
      const asOffset = localIndex >= 0 && block[localIndex + 1]?.value.toLowerCase() === 'as' ? 2 : 3;
      const localAs = numeric(block[localIndex + asOffset]?.value, defines) ?? node.asn;
      const neighborIndex = block.findIndex((token) => token.value.toLowerCase() === 'neighbor');
      const address = resolved(block[neighborIndex + 1]?.value, defines);
      const asIndex = block.findIndex(
        (token, candidate) => candidate > neighborIndex && token.value.toLowerCase() === 'as',
      );
      const remoteAs = numeric(block[asIndex + 1]?.value, defines);
      if (!localAs || !address || !tryParseIp(address) || !remoteAs) {
        diagnostics.push({
          severity: 'error',
          code: 'bird.bgp-required',
          file: tokens[open]?.file,
          line: tokens[open]?.line,
          message: `BGP protocol ${name} needs a numeric local AS and a neighbor address/AS.`,
        });
      } else {
        const families: IpFamily[] = [];
        if (channelBlock(block, 'ipv4')) families.push('ipv4');
        if (channelBlock(block, 'ipv6')) families.push('ipv6');
        if (families.length === 0) families.push(familyOf(address));
        const neighbor: ParsedBgpNeighbor = {
          address,
          remoteAs,
          localAs,
          addressFamilies: families,
          importPolicy: 'all',
          exportPolicy: 'none',
          routeServerClient: block.some(
            (token, candidate) =>
              token.value.toLowerCase() === 'rs' && block[candidate + 1]?.value.toLowerCase() === 'client',
          ),
        };
        const multihopIndex = block.findIndex((token) => token.value.toLowerCase() === 'multihop');
        if (multihopIndex >= 0) neighbor.multihop = numeric(block[multihopIndex + 1]?.value, defines) ?? 64;
        for (const family of families) {
          const channel = channelBlock(block, family) ?? block;
          const imported = extractPolicy(channel, 'import', defines);
          const exported = extractPolicy(channel, 'export', defines);
          neighbor.importPolicy = imported.mode;
          neighbor.importPrefixes = imported.prefixes;
          neighbor.exportPolicy = exported.mode;
          neighbor.exportPrefixes = exported.prefixes;
        }
        result.bgp.push({
          instanceName: name,
          localAs,
          routerId: result.routerId ?? node.routerId,
          networks: [],
          neighbors: [neighbor],
        });
      }
    } else if (type === 'ospf') {
      const family: IpFamily = variant === 'v3' || channelBlock(block, 'ipv6') ? 'ipv6' : 'ipv4';
      const areas: ParsedOspfArea[] = [];
      for (let areaIndex = 0; areaIndex < block.length; areaIndex += 1) {
        if (block[areaIndex]?.value.toLowerCase() !== 'area') continue;
        const area = resolved(block[areaIndex + 1]?.value, defines) ?? '0';
        const areaOpen = block.findIndex((token, candidate) => candidate > areaIndex && token.value === '{');
        if (areaOpen < 0) continue;
        const areaClose = findMatchingBrace(block, areaOpen);
        if (areaClose === undefined) continue;
        const areaTokens = block.slice(areaOpen + 1, areaClose);
        const interfacePatterns: string[] = [];
        const networks: string[] = [];
        for (let candidate = 0; candidate < areaTokens.length; candidate += 1) {
          const keyword = areaTokens[candidate]?.value.toLowerCase();
          const value = resolved(areaTokens[candidate + 1]?.value, defines);
          if (keyword === 'interface' && value) interfacePatterns.push(value);
          if (keyword === 'stubnet' && value && tryParsePrefix(value)) networks.push(normalizePrefix(value));
        }
        areas.push({ area, networks, interfacePatterns });
        areaIndex = areaClose;
      }
      if (areas.length === 0) areas.push({ area: '0', networks: [], interfacePatterns: ['*'] });
      const redistribute: Array<'connected' | 'static' | 'bgp'> = [];
      if (block.some((token) => token.value.toLowerCase() === 'external')) redistribute.push('static');
      result.ospf.push({ instanceName: name, family, areas, redistribute });
    }
    index = close;
  }

  const braceBalance = tokens.reduce(
    (balance, token) => balance + (token.value === '{' ? 1 : token.value === '}' ? -1 : 0),
    0,
  );
  if (braceBalance !== 0 && !diagnostics.some((candidate) => candidate.code === 'bird.block-unclosed')) {
    diagnostics.push({
      severity: 'error',
      code: 'bird.braces',
      file: entrypoint.path,
      message: 'Configuration has unbalanced braces.',
    });
  }
  return result;
}
