"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  Snowflake,
  Lock,
  Plus,
  X,
  Download,
  Loader2,
  Sparkles,
  Building2,
  FileSpreadsheet,
  ShieldCheck,
  Radar,
  GripVertical,
  CheckCircle2,
  AlertTriangle,
  Users,
  Layers,
  Cpu,
  Check,
  Search,
  Globe,
  FileText,
  UserCheck,
  Wrench,
  ExternalLink,
  Sun,
  Moon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { DEFAULT_COLUMNS, DEFAULT_PROMPT } from "@/lib/columns";
import { usePersistentState } from "@/lib/use-persistent-state";
import { checkPassword } from "@/lib/auth";
import { downloadCSV, downloadXLSX } from "@/lib/export";
import type { Row } from "@/lib/llm";

type ProviderOption = { id: string; label: string; grounded: boolean; models: string[] };
// Per-run stats from the multi-agent pipeline (fan-out → dedup → fact-check → enrich).
type MultiAgentTrace = {
  agents: number;
  rawTotal: number;
  afterDedup: number;
  removedDup: number;
  kept: number;
  dropped: number;
  enriched: number;
  models: string[];
};
type Merge = { kept: string; dropped: string[] };
// Per-agent provenance for the overlap matrix (mirrors lib/agents.ts AgentOverlap).
type AgentOverlapStat = {
  index: number;
  label: string;
  found: number;
  failed: boolean;
  contributed: number;
  uniqueVerified: number;
};
type OverlapBuilding = { building: string; agents: number[]; status: "verified" | "flagged" | "dropped" };
type AgentOverlap = { agents: number; stats: AgentOverlapStat[]; buildings: OverlapBuilding[] };
// One observable tool call (web search / scrape / enrichment), mirrors lib/search.ts ToolEvent.
type ToolEvent = {
  stage: "research" | "enrich";
  agent?: number;
  tool: "tavily" | "firecrawl" | "gemini" | "extract";
  label: string;
  query: string;
  resultCount: number;
  urls: string[];
  ok: boolean;
  detail?: string;
};
// Selectable AI-SDK model + registered-provider status (for the per-agent picker).
type AiModelOption = { id: string; label: string; provider: string; grounded: boolean };
type AiProviderStatus = { id: string; label: string; envKey: string; grounded: boolean; keyed: boolean };
type DroppedRow = { row: Row; note: string };
type ViewMode = "verified" | "raw";

// Renders a row's Citations (string[] of source URLs) as a compact stacked list of
// clickable links. Shows the hostname as the label to keep the cell narrow.
function CitationsCell({ urls }: { urls?: string[] }) {
  if (!urls || urls.length === 0)
    return <span className="block min-w-32 px-2 py-1 text-xs text-muted-foreground">N/A</span>;
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };
  return (
    <ul className="min-w-32 space-y-0.5 px-2 py-1">
      {urls.map((u, i) => (
        <li key={i}>
          <a
            href={u}
            target="_blank"
            rel="noreferrer"
            title={u}
            className="block truncate text-xs text-primary underline-offset-2 hover:underline"
          >
            {host(u)}
          </a>
        </li>
      ))}
    </ul>
  );
}
type IconType = React.ComponentType<{ className?: string }>;

const PW_KEY = "lg_pw"; // sessionStorage key for the unlock password

// One label style everywhere — wraps the `.label-mono` class so spacing/tracking
// never drift between sections.
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="label-mono">{children}</span>;
}

// A single agent's provider + model switcher. Used for BOTH the research and
// review agents so they share an identical layout (only the title/icon differ).
function AgentPicker({
  title,
  hint,
  Icon,
  providers,
  provider,
  onProvider,
  model,
  onModel,
  disabled = false,
}: {
  title: string;
  hint: string;
  Icon: IconType;
  providers: ProviderOption[];
  provider: string;
  onProvider: (v: string) => void;
  model: string;
  onModel: (v: string) => void;
  disabled?: boolean;
}) {
  const active = providers.find((p) => p.id === provider);
  return (
    <div
      className={`panel p-4 transition-opacity duration-200 ${disabled ? "opacity-50" : ""}`}
      aria-disabled={disabled}
    >
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
          <Icon className="size-4" />
        </span>
        <div className="leading-tight">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em]">{title}</p>
          <p className="label-mono mt-0.5 text-[10px] normal-case tracking-normal">{hint}</p>
        </div>
        {active && (
          <Badge variant="outline" className="ml-auto gap-1.5 font-mono text-[10px] uppercase">
            <span
              className={`size-1.5 rounded-full ${active.grounded ? "bg-primary" : "bg-muted-foreground"}`}
            />
            {active.grounded ? "grounded" : "knowledge"}
          </Badge>
        )}
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <FieldLabel>Provider</FieldLabel>
          <Select value={provider} onValueChange={(v) => onProvider(v ?? "")} disabled={disabled}>
            <SelectTrigger className="w-full font-mono">
              <SelectValue>{active?.label ?? "Select provider"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id} className="font-mono">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <FieldLabel>Model{active ? ` · ${active.models.length}` : ""}</FieldLabel>
          <Select
            value={model}
            onValueChange={(v) => onModel(v ?? "")}
            disabled={disabled || !active}
          >
            <SelectTrigger className="w-full font-mono">
              <SelectValue>{model || "Select model"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {active?.models.map((m) => (
                <SelectItem key={m} value={m} className="font-mono text-xs">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

// The Research-agent panel in Multi-model mode: one model dropdown per agent,
// styled to match AgentPicker so the two cards read as one panel. Replaces the
// single research provider/model picker when Multi-model is on.
function MultiModelResearch({
  agents,
  aiModels,
  aiProviders,
  agentModels,
  setAgentModels,
}: {
  agents: number;
  aiModels: AiModelOption[];
  aiProviders: AiProviderStatus[];
  agentModels: string[];
  setAgentModels: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const distinct = new Set(agentModels.slice(0, agents).filter(Boolean)).size;
  return (
    <div className="panel p-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
          <Radar className="size-4" />
        </span>
        <div className="leading-tight">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em]">Research agents</p>
          <p className="label-mono mt-0.5 text-[10px] normal-case tracking-normal">
            One model per agent · {distinct}/{agents} distinct
          </p>
        </div>
        <Badge variant="outline" className="ml-auto gap-1.5 font-mono text-[10px] uppercase">
          <Cpu className="size-3 text-primary" />
          multi-model
        </Badge>
      </div>

      {aiModels.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">Loading models…</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {Array.from({ length: agents }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <FieldLabel>Agent {i + 1}</FieldLabel>
              <Select
                value={agentModels[i] ?? ""}
                onValueChange={(v) =>
                  setAgentModels((prev) => {
                    const next = [...prev];
                    next[i] = v ?? "";
                    return next;
                  })
                }
              >
                <SelectTrigger className="w-full font-mono text-xs">
                  <SelectValue>
                    {aiModels.find((m) => m.id === agentModels[i])?.label ?? "Select model"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {aiModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      {/* What another key would unlock — drives the "add apikey afterwards" flow. */}
      {aiProviders.some((p) => !p.keyed) && (
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
          Add a key to unlock:{" "}
          {aiProviders
            .filter((p) => !p.keyed)
            .map((p) => `${p.label} (${p.envKey})`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

// Per-agent color from the theme's chart ramp. Built as an inline CSS var (not a
// `chart-${i}` class) so Tailwind's JIT can't purge a runtime-built class name.
const agentColor = (i: number) => `var(--chart-${(i % 5) + 1})`;

// The overlap matrix: a per-agent summary strip + a building × agent grid. Answers
// "which agents pull their weight" (solo-verified) and "does overlap/dedup really
// happen and on what scheme" (copies column + folded aliases), from REAL run data.
function AgentOverlapMatrix({ overlap }: { overlap: AgentOverlap }) {
  const { stats, buildings } = overlap;
  return (
    <div className="border-t border-border p-5">
      <div className="mb-3 flex items-center gap-2">
        <Radar className="size-3.5 text-primary" />
        <FieldLabel>Agent overlap · {buildings.length} buildings</FieldLabel>
      </div>

      {/* Per-agent summary strip — solo-verified is each agent's real marginal value. */}
      <div className="mb-4 flex flex-wrap gap-2">
        {stats.map((s) => (
          <div
            key={s.index}
            className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-1.5 font-mono text-[11px]"
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: agentColor(s.index) }} />
            <span className="text-muted-foreground">A{s.index + 1}</span>
            <span className="max-w-[130px] truncate" title={s.label}>
              {s.label}
            </span>
            {s.failed ? (
              <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-destructive">failed</span>
            ) : (
              <>
                <span className="text-muted-foreground">· {s.found} found</span>
                <span className="font-semibold text-primary">· {s.uniqueVerified} solo-verified</span>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Building × agent grid — ✓ = agent found it (incl. folded aliases); Copies = overlap. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th className="sticky left-0 z-10 bg-secondary/40 px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Building
              </th>
              {stats.map((s) => (
                <th
                  key={s.index}
                  className="px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider"
                  style={{ color: agentColor(s.index) }}
                  title={s.label}
                >
                  A{s.index + 1}
                </th>
              ))}
              <th className="px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Copies
              </th>
            </tr>
          </thead>
          <tbody>
            {buildings.map((b, r) => {
              const dropped = b.status === "dropped";
              return (
                <tr
                  key={r}
                  className={`border-b border-border/60 transition-colors hover:bg-primary/5 ${
                    dropped ? "opacity-60" : ""
                  }`}
                >
                  <td
                    className={`sticky left-0 z-10 bg-card px-3 py-1.5 font-mono text-xs ${
                      dropped ? "text-muted-foreground line-through" : ""
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {b.status === "verified" && (
                        <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-label="verified" />
                      )}
                      {b.status === "flagged" && (
                        <AlertTriangle className="size-3.5 shrink-0 text-warn" aria-label="flagged" />
                      )}
                      {dropped && <X className="size-3.5 shrink-0 text-destructive" aria-label="dropped" />}
                      {b.building}
                    </span>
                  </td>
                  {stats.map((s) => {
                    const hit = b.agents.includes(s.index);
                    return (
                      <td key={s.index} className="px-3 py-1.5 text-center">
                        {hit ? (
                          <Check
                            className="mx-auto size-3.5"
                            style={{ color: agentColor(s.index) }}
                            aria-label="found"
                          />
                        ) : (
                          <span className="text-muted-foreground/30">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-center font-mono text-xs tabular-nums text-muted-foreground">
                    {b.agents.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
        Copies = how many agents independently found this building. Solo-verified = buildings only that
        agent found that survived fact-check — an agent&apos;s real marginal value.
      </p>
    </div>
  );
}

// A single-select model picker over the RICH AI-SDK registry (all keyed providers),
// used for the review agent so it can pick from the same models as research — not
// just the 3 legacy providers.
function AiModelPicker({
  title,
  hint,
  Icon,
  aiModels,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  Icon: IconType;
  aiModels: AiModelOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const active = aiModels.find((m) => m.id === value);
  return (
    <div className="panel p-4">
      <div className="mb-3.5 flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25">
          <Icon className="size-4" />
        </span>
        <div className="leading-tight">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em]">{title}</p>
          <p className="label-mono mt-0.5 text-[10px] normal-case tracking-normal">{hint}</p>
        </div>
        {active && (
          <Badge variant="outline" className="ml-auto gap-1.5 font-mono text-[10px] uppercase">
            <span className={`size-1.5 rounded-full ${active.grounded ? "bg-primary" : "bg-muted-foreground"}`} />
            {active.grounded ? "grounded" : "knowledge"}
          </Badge>
        )}
      </div>
      <div className="space-y-1.5">
        <FieldLabel>Model{aiModels.length ? ` · ${aiModels.length}` : ""}</FieldLabel>
        <Select value={value} onValueChange={(v) => onChange(v ?? "")} disabled={!aiModels.length}>
          <SelectTrigger className="w-full font-mono">
            <SelectValue>{active?.label ?? "Select model"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {aiModels.map((m) => (
              <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// Icon + human label per tool kind, for the activity log.
const TOOL_META: Record<ToolEvent["tool"], { Icon: IconType; label: string }> = {
  tavily: { Icon: Search, label: "Web search (Tavily)" },
  firecrawl: { Icon: FileText, label: "Page scrape (Firecrawl)" },
  gemini: { Icon: Globe, label: "Google-Search grounding" },
  extract: { Icon: UserCheck, label: "Person-in-charge extraction" },
};

const shortHost = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u.slice(0, 40);
  }
};

// Renders the run's tool calls so the user can SEE that web search / LinkedIn lookup /
// enrichment actually ran — with the query, hit count, evidence URLs, and outcome.
function ToolActivity({ toolLog }: { toolLog: ToolEvent[] }) {
  const research = toolLog.filter((e) => e.stage === "research");
  const enrich = toolLog.filter((e) => e.stage === "enrich");

  const EventRow = (e: ToolEvent, i: number) => {
    const meta = TOOL_META[e.tool];
    return (
      <li key={i} className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-0">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <meta.Icon className={`size-3.5 shrink-0 ${e.ok ? "text-primary" : "text-muted-foreground/50"}`} />
          <span className="text-foreground">{meta.label}</span>
          {typeof e.agent === "number" && (
            <span className="rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">A{e.agent + 1}</span>
          )}
          <span className="truncate text-muted-foreground">{e.label}</span>
          <span className={`ml-auto shrink-0 ${e.ok ? "text-primary" : "text-warn"}`}>
            {e.resultCount} {e.resultCount === 1 ? "result" : "results"}
          </span>
        </div>
        <div className="pl-6 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
          <span className="text-muted-foreground/50">query:</span> {e.query}
        </div>
        {e.detail && <div className="pl-6 font-mono text-[10px] text-primary/80">{e.detail}</div>}
        {e.urls.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-6">
            {e.urls.map((u, j) => (
              <a
                key={j}
                href={u}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-[10px] text-primary/80 hover:text-primary hover:underline"
              >
                <ExternalLink className="size-2.5" />
                {shortHost(u)}
              </a>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="border-t border-border p-5">
      <div className="mb-3 flex items-center gap-2">
        <Wrench className="size-3.5 text-primary" />
        <FieldLabel>Tool activity · {toolLog.length} calls</FieldLabel>
      </div>
      {research.length > 0 && (
        <>
          <p className="label-mono mb-1 text-[10px]">Research · web search per agent</p>
          <ul className="mb-4">{research.map(EventRow)}</ul>
        </>
      )}
      {enrich.length > 0 && (
        <>
          <p className="label-mono mb-1 text-[10px]">Enrichment · LinkedIn / person-in-charge</p>
          <ul>{enrich.map(EventRow)}</ul>
        </>
      )}
    </div>
  );
}

// Light/dark switch. Renders a stable placeholder until mounted so the button
// doesn't flash the wrong icon during hydration (theme is unknown server-side).
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === "dark";
  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="grid size-8 cursor-pointer place-items-center rounded-lg border border-border bg-secondary/40 text-muted-foreground transition-colors hover:text-primary"
    >
      {!mounted ? <Sun className="size-4" /> : isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export default function Home() {
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState("");

  const [prompt, setPrompt] = usePersistentState("lg_prompt", DEFAULT_PROMPT);
  const [columns, setColumns] = usePersistentState<string[]>("lg_columns", DEFAULT_COLUMNS);
  const [providers, setProviders] = useState<ProviderOption[]>([]);

  // Research agent (finds candidates) and review agent (fact-checks) each pick
  // their own provider + model — same UI, independent state.
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [reviewProvider, setReviewProvider] = useState("");
  const [reviewModel, setReviewModel] = useState("");

  const [count, setCount] = usePersistentState("lg_count", 15);
  const [verify, setVerify] = usePersistentState("lg_verify", true);
  const [agents, setAgents] = usePersistentState("lg_agents", 3); // concurrent research agents (1..5)
  const [enrich, setEnrich] = usePersistentState("lg_enrich", false); // LinkedIn person-in-charge lookup (opt-in; pricey)
  const [modelPanel, setModelPanel] = usePersistentState("lg_model_panel", true); // ON by default → 3 distinct models (goal)
  const [aiModels, setAiModels] = useState<AiModelOption[]>([]); // selectable models (keyed providers)
  const [aiProviders, setAiProviders] = useState<AiProviderStatus[]>([]); // registry status (for hints)
  const [agentModels, setAgentModels] = usePersistentState<string[]>("lg_agent_models", []); // per-agent model id, index = agent
  const [reviewInstructions, setReviewInstructions] = usePersistentState("lg_review_instructions", "");

  const [rows, setRows] = useState<Row[]>([]); // verified ("after")
  const [before, setBefore] = useState<Row[] | null>(null); // raw candidates, pre-dedup
  const [dropped, setDropped] = useState<DroppedRow[]>([]); // rows the reviewer cut + reasons
  const [merges, setMerges] = useState<Merge[]>([]); // duplicate buildings the dedup agent folded
  const [view, setView] = useState<ViewMode>("verified");
  const [trace, setTrace] = useState<MultiAgentTrace | null>(null);
  const [overlap, setOverlap] = useState<AgentOverlap | null>(null); // per-agent provenance matrix
  const [reviewModelId, setReviewModelId] = usePersistentState("lg_review_model", ""); // AI-SDK model id for the review agent
  const [toolLog, setToolLog] = useState<ToolEvent[]>([]); // observable tool calls from the run
  const [loading, setLoading] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Ask the server which providers have keys, then default both agents to the first.
  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers");
      const data = (await res.json()) as { providers: ProviderOption[] };
      setProviders(data.providers);
      const first = data.providers[0]?.id || "";
      setProvider((p) => p || first);
      setReviewProvider((p) => p || first);
    } catch {
      toast.error("Could not load providers");
    }
  }, []);

  // Restore an unlocked session on refresh (password kept in sessionStorage).
  useEffect(() => {
    const saved = sessionStorage.getItem(PW_KEY);
    if (saved && checkPassword(saved)) {
      setPwInput(saved);
      setUnlocked(true);
    }
  }, []);

  useEffect(() => {
    if (unlocked) loadProviders();
  }, [unlocked, loadProviders]);

  // Load the selectable AI-SDK models for the per-agent picker (Multi-model mode).
  const loadAiModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models");
      const data = (await res.json()) as { models: AiModelOption[]; providers: AiProviderStatus[] };
      setAiModels(data.models ?? []);
      setAiProviders(data.providers ?? []);
    } catch {
      toast.error("Could not load AI-SDK models");
    }
  }, []);

  // Load the rich AI-SDK model list on unlock (not just in Multi-model mode) — the
  // review agent picker uses it too now, so it must be available even when the
  // research fan-out isn't in panel mode.
  useEffect(() => {
    if (unlocked) loadAiModels();
  }, [unlocked, loadAiModels]);

  // Default the review agent to a sensible AI-SDK model once the list loads
  // (prefer gemini-flash-lite-latest), preserving any manual pick that's still valid.
  useEffect(() => {
    if (!aiModels.length) return;
    setReviewModelId((cur) => {
      if (cur && aiModels.some((m) => m.id === cur)) return cur;
      return aiModels.find((m) => m.id === "gemini:gemini-flash-lite-latest")?.id ?? aiModels[0].id;
    });
  }, [aiModels]);

  // Keep agentModels sized to `agents`, defaulting to DISTINCT models by sequence.
  // The goal default is "one Gemini, one Groq-Llama, one GPT" — using models that
  // actually run (gpt-oss via Groq, not the gateway gpt-4o which needs a paid key).
  // Then fill any extra agents with the remaining distinct models. Preserves user picks.
  useEffect(() => {
    if (!aiModels.length) return;
    const ids = aiModels.map((m) => m.id);
    const preferred = [
      "gemini:gemini-flash-lite-latest",
      "groq:llama-3.3-70b-versatile",
      "groq:openai/gpt-oss-120b", // a working GPT on the (free) Groq key
    ].filter((id) => ids.includes(id));
    const seq = [...preferred, ...ids.filter((id) => !preferred.includes(id))]; // preferred first
    setAgentModels((prev) =>
      Array.from({ length: agents }, (_, i) => {
        const cur = prev[i];
        if (cur && ids.includes(cur)) return cur; // keep a still-valid manual pick
        return seq[i % seq.length]; // distinct default, by sequence
      })
    );
  }, [aiModels, agents]);

  // Keep each agent's model valid for its selected provider: when a provider
  // changes (or the lists load), snap that agent's model to the first option.
  useEffect(() => {
    const opt = providers.find((p) => p.id === provider);
    if (opt) setModel(opt.models[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, providers]);

  useEffect(() => {
    const opt = providers.find((p) => p.id === reviewProvider);
    if (opt) setReviewModel(opt.models[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewProvider, providers]);

  function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!checkPassword(pwInput)) {
      toast.error("Wrong password");
      return;
    }
    sessionStorage.setItem(PW_KEY, pwInput);
    setUnlocked(true);
  }

  // --- column editing ---
  const renameColumn = (i: number, value: string) =>
    setColumns((cols) => cols.map((c, idx) => (idx === i ? value : c)));
  const removeColumn = (i: number) =>
    setColumns((cols) => cols.filter((_, idx) => idx !== i));
  const addColumn = () => setColumns((cols) => [...cols, `Column ${cols.length + 1}`]);

  // Drag-to-reorder: moving a chip rewrites `columns`, which also reorders the
  // table and the CSV/XLSX export (both serialize in `columns` order).
  const moveColumn = (from: number, to: number) =>
    setColumns((cols) => {
      if (from === to || to < 0 || to >= cols.length) return cols;
      const next = [...cols];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  // Wipe persisted settings back to defaults. Setting each state back to its
  // default lets the usePersistentState write-effects rewrite localStorage;
  // clearing agentModels/reviewModelId lets the async default effects repopulate
  // the distinct-model defaults once /api/models has loaded.
  const resetSettings = () => {
    setPrompt(DEFAULT_PROMPT);
    setColumns(DEFAULT_COLUMNS);
    setCount(15);
    setVerify(true);
    setAgents(3);
    setEnrich(false);
    setModelPanel(true);
    setAgentModels([]);
    setReviewInstructions("");
    setReviewModelId("");
    toast.success("Settings reset to defaults");
  };

  // --- cell editing (lets the user "compile nicely" before export) ---
  const updateCell = (rowIndex: number, col: string, value: string) =>
    setRows((rs) => rs.map((r, idx) => (idx === rowIndex ? { ...r, [col]: value } : r)));

  async function generate() {
    if (!prompt.trim()) return toast.error("Enter a search brief first");
    if (columns.length === 0) return toast.error("Add at least one column");
    if (!provider) return toast.error("No provider configured");

    setLoading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: sessionStorage.getItem(PW_KEY),
          provider,
          model,
          reviewProvider,
          reviewModel,
          reviewModelId, // AI-SDK model for the review agent (unified registry)
          prompt,
          columns,
          count,
          verify,
          agents,
          enrich,
          modelPanel,
          agentModels: modelPanel ? agentModels.slice(0, agents) : undefined,
          reviewInstructions,
        }),
      });
      const data = (await res.json()) as {
        rows?: Row[];
        before?: Row[];
        dropped?: DroppedRow[];
        merges?: Merge[];
        overlap?: AgentOverlap;
        toolLog?: ToolEvent[];
        trace?: MultiAgentTrace;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setRows(data.rows ?? []);
      setBefore(data.before ?? null);
      setDropped(data.dropped ?? []);
      setMerges(data.merges ?? []);
      setOverlap(data.overlap ?? null);
      setToolLog(data.toolLog ?? []);
      setTrace(data.trace ?? null);
      setView("verified");
      toast.success(`Generated ${data.rows?.length ?? 0} buildings`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }

  // The rows currently on screen (verified by default; raw when toggled).
  const displayRows = view === "raw" && before ? before : rows;

  function exportFile(kind: "csv" | "xlsx") {
    if (displayRows.length === 0) return toast.error("Nothing to export yet");
    const stamp = new Date().toISOString().slice(0, 10);
    const tag = view === "raw" ? "raw" : "verified";
    const name = `leads-${provider}-${tag}-${stamp}.${kind}`;
    if (kind === "csv") downloadCSV(displayRows, columns, name);
    else downloadXLSX(displayRows, columns, name);
    toast.success(`Exported ${name}`);
  }

  // ---------------------------------------------------------------- password gate
  if (!unlocked) {
    return (
      <main className="flex flex-1 items-center justify-center px-4">
        <form
          onSubmit={handleUnlock}
          className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-3 duration-500"
        >
          <div className="panel p-8 shadow-2xl">
            <div className="mb-6 flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
                <Snowflake className="size-5" />
              </span>
              <div>
                <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.2em]">
                  Lead Console
                </h1>
                <p className="label-mono">Restricted access</p>
              </div>
            </div>

            <FieldLabel>Password</FieldLabel>
            <div className="relative mt-1.5">
              <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder="••••••••"
                className="pl-9 font-mono"
              />
            </div>

            <Button type="submit" className="mt-5 w-full cursor-pointer font-mono uppercase tracking-wider">
              Unlock
            </Button>
          </div>
        </form>
      </main>
    );
  }

  const activeProvider = providers.find((p) => p.id === provider);

  // ---------------------------------------------------------------- main console
  return (
    <main className="flex flex-1 flex-col">
      {/* Header bar */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
              <Snowflake className="size-5" />
            </span>
            <div className="leading-tight">
              <h1 className="font-mono text-[13px] font-semibold uppercase tracking-[0.22em]">
                Chilled-Water Lead Console
              </h1>
              <p className="label-mono mt-0.5 text-[10px]">Building &amp; facility prospecting</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeProvider && (
              <Badge variant="outline" className="gap-1.5 font-mono text-[10px] uppercase">
                <span className="size-1.5 rounded-full bg-primary" />
                {activeProvider.grounded ? "web-grounded" : "knowledge"}
              </Badge>
            )}
            <Badge variant="secondary" className="font-mono text-[10px]">
              {rows.length} rows
            </Badge>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl flex-1 space-y-5 px-5 py-6">
        {/* 01 — QUERY + AGENTS */}
        <section className="panel animate-in fade-in slide-in-from-bottom-2 p-5 duration-500">
          <div className="mb-3 flex items-center gap-2">
            <span className="section-kicker">01</span>
            <FieldLabel>Search brief</FieldLabel>
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Describe the buildings you want to find…"
            className="resize-none font-sans text-sm leading-relaxed"
          />

          {/* Reviewer instruction bar — steers the review agent (verify mode only) */}
          {verify && (
            <div className="mt-4 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="size-3.5 text-primary" />
                <FieldLabel>Reviewer instructions · optional</FieldLabel>
              </div>
              <Textarea
                value={reviewInstructions}
                onChange={(e) => setReviewInstructions(e.target.value)}
                rows={2}
                placeholder="Rules the review agent must enforce — e.g. reject buildings on split-unit/VRF AC; be strict on the >5 storey rule; require a named facility/maintenance contact."
                className="resize-none font-sans text-sm leading-relaxed"
              />
            </div>
          )}

          {/* Research + review. In Multi-model mode the research card BECOMES the
              per-agent model panel (one card, not a separate section below). */}
          {verify && modelPanel ? (
            <div className="mt-5 space-y-3">
              <MultiModelResearch
                agents={agents}
                aiModels={aiModels}
                aiProviders={aiProviders}
                agentModels={agentModels}
                setAgentModels={setAgentModels}
              />
              <AiModelPicker
                title="Review agent"
                hint="Dedups + fact-checks · any model"
                Icon={ShieldCheck}
                aiModels={aiModels}
                value={reviewModelId}
                onChange={setReviewModelId}
              />
            </div>
          ) : (
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <AgentPicker
                title="Research agent"
                hint="Finds candidate buildings"
                Icon={Radar}
                providers={providers}
                provider={provider}
                onProvider={setProvider}
                model={model}
                onModel={setModel}
              />
              <AiModelPicker
                title="Review agent"
                hint={verify ? "Fact-checks each candidate · any model" : "Enable Verify to use"}
                Icon={ShieldCheck}
                aiModels={aiModels}
                value={reviewModelId}
                onChange={setReviewModelId}
              />
            </div>
          )}

          {providers.length === 0 && (
            <p className="mt-3 font-mono text-xs text-destructive">
              No API keys configured — add one to .env.local
            </p>
          )}

          {/* Run controls */}
          <div className="mt-5 flex flex-wrap items-end gap-4 border-t border-border pt-5">
            <div className="w-24 space-y-1.5">
              <FieldLabel>Limit</FieldLabel>
              <Input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="font-mono"
              />
            </div>

            {/* Agents — how many researchers fan out concurrently (verify path). */}
            {verify && (
              <div className="w-24 space-y-1.5">
                <FieldLabel>Agents</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={5}
                  value={agents}
                  onChange={(e) => setAgents(Math.min(Math.max(Number(e.target.value) || 1, 1), 5))}
                  className="font-mono"
                />
              </div>
            )}

            {/* Verify toggle — turns on the multi-agent fan-out → dedup → fact-check pipeline */}
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3">
              <ShieldCheck
                className={`size-4 ${verify ? "text-primary" : "text-muted-foreground"}`}
              />
              <span className="label-mono text-[11px]">Verify</span>
              <Switch checked={verify} onCheckedChange={setVerify} />
            </label>

            {/* Multi-model toggle — each agent runs a different model (Vercel AI SDK). */}
            {verify && (
              <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3">
                <Cpu className={`size-4 ${modelPanel ? "text-primary" : "text-muted-foreground"}`} />
                <span className="label-mono text-[11px]">Multi-model</span>
                <Switch checked={modelPanel} onCheckedChange={setModelPanel} />
              </label>
            )}

            {/* Enrich toggle — LinkedIn person-in-charge lookup on the kept rows. */}
            {verify && (
              <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3">
                <Users className={`size-4 ${enrich ? "text-primary" : "text-muted-foreground"}`} />
                <span className="label-mono text-[11px]">Enrich</span>
                <Switch checked={enrich} onCheckedChange={setEnrich} />
              </label>
            )}

            <Button
              onClick={generate}
              disabled={loading || providers.length === 0}
              className="ml-auto cursor-pointer font-mono uppercase tracking-wider"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {loading ? (verify ? "Verifying" : "Generating") : "Generate"}
            </Button>
          </div>

        </section>

        {/* 02 — COLUMNS */}
        <section className="panel animate-in fade-in slide-in-from-bottom-2 p-5 delay-100 duration-500">
          <div className="mb-3 flex items-center gap-2">
            <span className="section-kicker">02</span>
            <FieldLabel>Columns · {columns.length}</FieldLabel>
            <span className="font-mono text-[10px] text-muted-foreground/70">drag to reorder</span>
            {/* Settings persist in localStorage across sessions — this is the escape hatch. */}
            <button
              onClick={resetSettings}
              className="ml-auto cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-foreground"
              title="Clear saved columns, models, and prompts — restore defaults"
            >
              Reset to defaults
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {columns.map((col, i) => (
              <div
                key={i}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null) moveColumn(dragIndex, i);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                className={`group flex items-center gap-1 rounded-lg border bg-secondary/50 pr-1 transition-colors focus-within:border-primary/60 hover:border-primary/40 ${
                  dragIndex === i ? "border-primary opacity-50" : "border-border"
                }`}
              >
                <span className="cursor-grab pl-1.5 text-muted-foreground/60 active:cursor-grabbing">
                  <GripVertical className="size-3.5" />
                </span>
                <input
                  value={col}
                  onChange={(e) => renameColumn(i, e.target.value)}
                  size={Math.max(col.length, 4)}
                  className="bg-transparent py-1.5 font-mono text-xs outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeColumn(i)}
                  aria-label={`Remove ${col}`}
                  className="grid size-5 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addColumn}
              className="flex cursor-pointer items-center gap-1 rounded-lg border border-dashed border-primary/40 px-2.5 py-1.5 font-mono text-xs text-primary transition-colors hover:bg-primary/10"
            >
              <Plus className="size-3" /> Add
            </button>
          </div>
        </section>

        {/* 03 — RESULTS */}
        <section className="panel animate-in fade-in slide-in-from-bottom-2 delay-200 duration-500">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="section-kicker">03</span>
                <FieldLabel>Results</FieldLabel>
              </div>
              {trace ? (
                <Badge variant="outline" className="gap-1.5 font-mono text-[10px]">
                  <Layers className="size-3 text-primary" />
                  {trace.agents}× agents · {trace.rawTotal} raw → {trace.afterDedup} unique → {trace.kept} verified
                  {trace.dropped > 0 && ` · ${trace.dropped} dropped`}
                  {trace.enriched > 0 && ` · ${trace.enriched} PIC`}
                </Badge>
              ) : (
                before &&
                before.length > 0 && (
                  <Badge variant="outline" className="gap-1.5 font-mono text-[10px]">
                    <ShieldCheck className="size-3 text-primary" />
                    {before.length} raw → {rows.length} verified · {dropped.length} dropped
                  </Badge>
                )
              )}
              {/* Which models the fan-out ran on — only when the panel used >1. */}
              {trace && trace.models.length > 1 && (
                <Badge variant="outline" className="gap-1.5 font-mono text-[10px]">
                  <Cpu className="size-3 text-primary" />
                  {trace.models.join(" · ")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Before/After toggle — appears only when a raw snapshot exists (verify mode) */}
              {before && before.length > 0 && (
                <div className="flex overflow-hidden rounded-lg border border-border font-mono text-[10px] uppercase tracking-wider">
                  <button
                    type="button"
                    onClick={() => setView("raw")}
                    className={`cursor-pointer px-3 py-1.5 transition-colors ${
                      view === "raw"
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary/50"
                    }`}
                  >
                    Raw
                  </button>
                  <button
                    type="button"
                    onClick={() => setView("verified")}
                    className={`cursor-pointer px-3 py-1.5 transition-colors ${
                      view === "verified"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-secondary/50"
                    }`}
                  >
                    Verified
                  </button>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportFile("csv")}
                disabled={displayRows.length === 0}
                className="cursor-pointer font-mono text-xs uppercase tracking-wider"
              >
                <Download className="size-3.5" /> CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportFile("xlsx")}
                disabled={displayRows.length === 0}
                className="cursor-pointer font-mono text-xs uppercase tracking-wider"
              >
                <FileSpreadsheet className="size-3.5" /> XLSX
              </Button>
            </div>
          </div>

          {displayRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
              <span className="grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Building2 className="size-7" />
              </span>
              <p className="font-mono text-sm text-muted-foreground">
                No buildings yet — write a brief and hit Generate.
              </p>
            </div>
          ) : (
            <>
              {/* Raw-view banner: makes the "before" obviously unverified for the demo. */}
              {view === "raw" && (
                <div className="flex items-center gap-2 border-b border-border bg-secondary/20 px-5 py-2.5 font-mono text-[11px] text-muted-foreground">
                  <AlertTriangle className="size-3.5 text-warn" />
                  Raw model output — straight from the LLM, before the review agent fact-checked it.
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-secondary/40">
                      <th className="sticky left-0 z-10 bg-secondary/40 px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        #
                      </th>
                      {columns.map((col, i) => (
                        <th
                          key={i}
                          className="whitespace-nowrap px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-wider text-primary"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((row, r) => {
                      const verifiedView = view === "verified";
                      const flagged = verifiedView && row.__status === "flagged";
                      return (
                        <Fragment key={r}>
                          <tr className="border-b border-border/60 transition-colors hover:bg-primary/5">
                            <td className="sticky left-0 z-10 bg-card px-3 py-1 font-mono text-xs text-muted-foreground">
                              <span className="flex items-center gap-1.5">
                                {verifiedView && row.__status === "verified" && (
                                  <CheckCircle2 className="size-3.5 text-primary" aria-label="verified" />
                                )}
                                {flagged && (
                                  <AlertTriangle className="size-3.5 text-warn" aria-label="flagged" />
                                )}
                                {String(r + 1).padStart(2, "0")}
                              </span>
                            </td>
                            {columns.map((col, c) => (
                              <td key={c} className="px-1 py-1 align-top">
                                {col === "Citations" ? (
                                  // Citations is a per-row string[] of source URLs — render as a
                                  // stacked list of clickable links, not an editable text cell.
                                  <CitationsCell urls={row.Citations} />
                                ) : verifiedView ? (
                                  <input
                                    value={row[col] ?? ""}
                                    onChange={(e) => updateCell(r, col, e.target.value)}
                                    className="min-w-32 rounded bg-transparent px-2 py-1 text-xs outline-none transition-colors focus:bg-input/40 focus:ring-1 focus:ring-primary/40"
                                  />
                                ) : (
                                  <span className="block min-w-32 px-2 py-1 text-xs text-muted-foreground">
                                    {row[col] ?? ""}
                                  </span>
                                )}
                              </td>
                            ))}
                          </tr>
                          {/* Flagged → show the reviewer's reason inline, under the row. */}
                          {flagged && row.__note && (
                            <tr className="bg-warn/5">
                              <td />
                              <td
                                colSpan={columns.length}
                                className="px-3 pb-2 font-mono text-[11px] text-warn"
                              >
                                <span className="inline-flex items-start gap-1.5">
                                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                                  Reviewer: {row.__note}
                                </span>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Agent overlap matrix — who found what, how much they overlapped, real value. */}
              {view === "verified" && overlap && overlap.agents > 1 && overlap.buildings.length > 0 && (
                <AgentOverlapMatrix overlap={overlap} />
              )}

              {/* Tool activity — proves web search / LinkedIn lookup / enrichment ran. */}
              {view === "verified" && toolLog.length > 0 && <ToolActivity toolLog={toolLog} />}

              {/* Duplicates the dedup agent folded together (alias/typo matches). */}
              {view === "verified" && merges.length > 0 && (
                <div className="border-t border-border p-5">
                  <div className="mb-2.5 flex items-center gap-2">
                    <Layers className="size-3.5 text-primary" />
                    <FieldLabel>Duplicates merged · {merges.length}</FieldLabel>
                  </div>
                  <ul className="space-y-1.5">
                    {merges.map((m, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
                        <span className="text-primary">{m.kept}</span>
                        <span className="text-muted-foreground">← {m.dropped.join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Dropped rows + reasons — the review agent's value, made visible. */}
              {view === "verified" && dropped.length > 0 && (
                <div className="border-t border-border p-5">
                  <div className="mb-2.5 flex items-center gap-2">
                    <X className="size-3.5 text-destructive" />
                    <FieldLabel>Removed by reviewer · {dropped.length}</FieldLabel>
                  </div>
                  <ul className="space-y-1.5">
                    {dropped.map((d, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs">
                        <span className="text-destructive line-through">
                          {d.row.Building ?? d.row[columns[0]] ?? "—"}
                        </span>
                        <span className="text-muted-foreground">— {d.note}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
