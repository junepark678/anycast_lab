import type { Edge, Node } from '@xyflow/react';

export type NodeKind =
  | 'bird'
  | 'frr'
  | 'client'
  | 'service'
  | 'switch'
  | 'route-server';

export type RuntimeProvenance = 'native-wasm' | 'compatibility' | 'builtin';

export interface LabNodeViewData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  location?: string;
  enabled: boolean;
  status: 'stopped' | 'starting' | 'running' | 'failed';
  runtime: RuntimeProvenance;
  runtimeLabel: string;
  asn?: number;
  addresses: string[];
}

export type LabCanvasNode = Node<LabNodeViewData, 'labNode'>;

export interface LabLinkViewData extends Record<string, unknown> {
  label?: string;
  latencyMs: number;
  jitterMs: number;
  lossPercent: number;
  bandwidthMbps: number;
  enabled: boolean;
}

export type LabCanvasEdge = Edge<LabLinkViewData>;

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'link'; id: string }
  | null;

export interface ConfigFileView {
  path: string;
  contents: string;
  language: 'bird' | 'frr' | 'shell' | 'plaintext';
  dirty?: boolean;
}

export interface TerminalLine {
  id: string;
  stream: 'input' | 'output' | 'error' | 'system';
  text: string;
}

export interface TraceHopView {
  index: number;
  nodeId: string;
  nodeLabel: string;
  ingress?: string;
  egress?: string;
  matchedPrefix?: string;
  nextHop?: string;
  latencyMs: number;
  cumulativeMs: number;
  outcome: 'forwarded' | 'delivered' | 'dropped' | 'loop';
  explanation: string;
}

export interface TimelineEventView {
  id: string;
  timeMs: number;
  category: 'system' | 'link' | 'protocol' | 'route' | 'packet';
  nodeId?: string;
  summary: string;
  detail?: string;
}
