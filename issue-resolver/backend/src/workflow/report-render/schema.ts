import { z } from 'zod';

const STATUSES = ['pass', 'fail', 'blocked', 'running', 'na'] as const;
export type DiagramStatus = (typeof STATUSES)[number];

const statusSchema = z.enum(STATUSES);

const flowNodeSchema = z.union([
  z.string(),
  z.object({ label: z.string(), status: statusSchema.optional() }),
]);

const flowEdgeSchema = z.union([
  z.tuple([z.string(), z.string()]),
  z.object({ from: z.string(), to: z.string(), label: z.string().optional() }),
]);

const flowSchema = z.object({
  kind: z.literal('flow'),
  title: z.string(),
  nodes: z.array(flowNodeSchema).min(1),
  edges: z.array(flowEdgeSchema).optional(),
  note: z.string().optional(),
});

const barsSchema = z.object({
  kind: z.literal('bars'),
  title: z.string(),
  items: z
    .array(
      z.object({
        label: z.string(),
        value: z.number(),
        status: statusSchema.optional(),
      }),
    )
    .min(1),
  unit: z.string().optional(),
});

const matrixSchema = z.object({
  kind: z.literal('matrix'),
  title: z.string(),
  columns: z.array(z.string()).min(1),
  rows: z
    .array(
      z.object({
        label: z.string(),
        cells: z.array(z.string()),
      }),
    )
    .min(1),
});

const svgSchema = z.object({
  kind: z.literal('svg'),
  title: z.string().optional(),
  body: z.string(),
});

const diagramSchema = z.discriminatedUnion('kind', [
  flowSchema,
  barsSchema,
  matrixSchema,
  svgSchema,
]);

export type Diagram = z.infer<typeof diagramSchema>;
export type FlowDiagram = z.infer<typeof flowSchema>;
export type BarsDiagram = z.infer<typeof barsSchema>;
export type MatrixDiagram = z.infer<typeof matrixSchema>;
export type SvgDiagram = z.infer<typeof svgSchema>;

export interface ReportMetric {
  label: string;
  value: string | number;
  hint?: string;
}

export interface ReportDoc {
  verdict?: 'pass' | 'fail' | 'blocked';
  title?: string;
  subtitle?: string;
  generatedAt?: string;
  metrics?: ReportMetric[];
  diagrams?: Diagram[];
}

export interface ParsedReport {
  doc: ReportDoc | null;
  warnings: string[];
}

const metricSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  hint: z.string().optional(),
});

const KNOWN_KINDS = ['flow', 'bars', 'matrix', 'svg'] as const;

function parseDiagram(raw: unknown, warnings: string[]): Diagram | null {
  const kind =
    typeof raw === 'object' && raw !== null
      ? (raw as { kind?: unknown }).kind
      : undefined;
  if (typeof kind !== 'string') {
    warnings.push('report.json: diagram without a kind was skipped');
    return null;
  }
  const parsed = diagramSchema.safeParse(raw);
  if (!parsed.success) {
    const known = (KNOWN_KINDS as readonly string[]).includes(kind);
    warnings.push(
      known
        ? `report.json: diagram "${kind}" is malformed and was skipped`
        : `report.json: unknown diagram kind "${kind}" was skipped`,
    );
    return null;
  }
  if (parsed.data.kind === 'flow') {
    const labels = new Set(
      parsed.data.nodes.map((node) => (typeof node === 'string' ? node : node.label)),
    );
    const name = (edge: { from: string; to: string }): [string, string] => [
      edge.from,
      edge.to,
    ];
    const edges = (parsed.data.edges ?? []).filter((edge) => {
      const [from, to] = Array.isArray(edge) ? edge : name(edge);
      const known = labels.has(from) && labels.has(to);
      if (!known) {
        const missing = [from, to].filter((node) => !labels.has(node));
        warnings.push(
          `report.json: flow "${parsed.data.title}" edge to unknown node dropped (${missing.join(', ')})`,
        );
      }
      return known;
    });
    return { ...parsed.data, edges };
  }
  return parsed.data;
}

export function parseReportDoc(raw: unknown): ParsedReport {
  if (raw === null || raw === undefined) return { doc: null, warnings: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      doc: null,
      warnings: ['report.json: not a JSON object — ignored'],
    };
  }

  const source = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const doc: ReportDoc = {};

  if (source.verdict !== undefined) {
    const verdict = z.enum(['pass', 'fail', 'blocked']).safeParse(source.verdict);
    if (verdict.success) doc.verdict = verdict.data;
    else {
      warnings.push('report.json: verdict must be pass|fail|blocked');
      return { doc: null, warnings };
    }
  }
  for (const key of ['title', 'subtitle', 'generatedAt'] as const) {
    if (source[key] === undefined) continue;
    if (typeof source[key] === 'string') doc[key] = source[key] as string;
    else warnings.push(`report.json: ${key} must be a string`);
  }
  if (source.metrics !== undefined) {
    const metrics = z.array(metricSchema).safeParse(source.metrics);
    if (metrics.success) doc.metrics = metrics.data;
    else warnings.push('report.json: metrics is not an array of {label,value}');
  }
  if (source.diagrams !== undefined) {
    if (!Array.isArray(source.diagrams)) {
      warnings.push('report.json: diagrams must be an array');
      return { doc: null, warnings };
    }
    const diagrams: Diagram[] = [];
    for (const entry of source.diagrams) {
      const diagram = parseDiagram(entry, warnings);
      if (diagram) diagrams.push(diagram);
    }
    if (diagrams.length > 0) doc.diagrams = diagrams;
  }

  return { doc, warnings };
}