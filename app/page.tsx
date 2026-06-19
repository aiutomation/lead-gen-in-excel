"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
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
import { checkPassword } from "@/lib/auth";
import { downloadCSV, downloadXLSX } from "@/lib/export";
import type { Row } from "@/lib/llm";

type ProviderOption = { id: string; label: string; grounded: boolean; models: string[] };
type RoundLog = { round: number; found: number; kept: number; dropped: number };
type DroppedRow = { row: Row; note: string };
type ViewMode = "verified" | "raw";
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

export default function Home() {
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState("");

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [providers, setProviders] = useState<ProviderOption[]>([]);

  // Research agent (finds candidates) and review agent (fact-checks) each pick
  // their own provider + model — same UI, independent state.
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [reviewProvider, setReviewProvider] = useState("");
  const [reviewModel, setReviewModel] = useState("");

  const [count, setCount] = useState(15);
  const [verify, setVerify] = useState(true);
  const [reviewInstructions, setReviewInstructions] = useState("");

  const [rows, setRows] = useState<Row[]>([]); // verified ("after")
  const [before, setBefore] = useState<Row[] | null>(null); // raw model output, pre-review
  const [dropped, setDropped] = useState<DroppedRow[]>([]); // rows the reviewer cut + reasons
  const [view, setView] = useState<ViewMode>("verified");
  const [trace, setTrace] = useState<RoundLog[] | null>(null);
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
          prompt,
          columns,
          count,
          verify,
          reviewInstructions,
        }),
      });
      const data = (await res.json()) as {
        rows?: Row[];
        before?: Row[];
        dropped?: DroppedRow[];
        trace?: RoundLog[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setRows(data.rows ?? []);
      setBefore(data.before ?? null);
      setDropped(data.dropped ?? []);
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
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl flex-1 space-y-5 px-5 py-6">
        {/* 01 — QUERY + AGENTS */}
        <section className="panel animate-in fade-in slide-in-from-bottom-2 p-5 duration-500">
          <div className="mb-3 flex items-center gap-2">
            <span className="kicker">01</span>
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

          {/* Two agents, one layout — research finds, review fact-checks. */}
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
            <AgentPicker
              title="Review agent"
              hint={verify ? "Fact-checks each candidate" : "Enable Verify to use"}
              Icon={ShieldCheck}
              providers={providers}
              provider={reviewProvider}
              onProvider={setReviewProvider}
              model={reviewModel}
              onModel={setReviewModel}
              disabled={!verify}
            />
          </div>

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

            {/* Verify toggle — turns on the researcher→reviewer→regenerate loop */}
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3">
              <ShieldCheck
                className={`size-4 ${verify ? "text-primary" : "text-muted-foreground"}`}
              />
              <span className="label-mono text-[11px]">Verify</span>
              <Switch checked={verify} onCheckedChange={setVerify} />
            </label>

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
            <span className="kicker">02</span>
            <FieldLabel>Columns · {columns.length}</FieldLabel>
            <span className="font-mono text-[10px] text-muted-foreground/70">drag to reorder</span>
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
                <span className="kicker">03</span>
                <FieldLabel>Results</FieldLabel>
              </div>
              {before && before.length > 0 && (
                <Badge variant="outline" className="gap-1.5 font-mono text-[10px]">
                  <ShieldCheck className="size-3 text-primary" />
                  {before.length} raw → {rows.length} verified · {dropped.length} dropped
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
                                {verifiedView ? (
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
