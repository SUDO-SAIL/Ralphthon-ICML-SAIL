/**
 * Review-loop API — contract v2 (cycle model), mirroring the real ICML process.
 *
 * One CYCLE = one submission to the venue:
 *   submit → 3 reviewer reviews (no score yet)
 *     → rebuttal thread (author messages incl. per-comment replies, reviewer
 *       follow-ups, hunk-level AI-revision decisions logged as rebuttal text)
 *     → finalize: the AC meta-review is written off the reviews + the whole
 *       discussion — ONLY THEN a score and an accept/reject decision appear
 *     → resubmit: the next cycle starts FRESH on the revised manuscript
 *       (new reviews, empty thread — like submitting to ICML again).
 *
 * When VITE_RALPH_API_URL is set every call maps 1:1 onto the backend
 * (icml-ac/serve/sail_adapter.py, contract v2); otherwise the mock below
 * simulates the loop deterministically and persists to IndexedDB.
 */

export type LoopStatus = "in_discussion" | "decided";
export type CycleDecision = "accept" | "reject";

/** One reviewer's review of a cycle (rating is ICML-style 1–10). */
export interface ReviewerReview {
  id: string;
  reviewer: string;
  rating: number;
  summary: string;
  /** Full ICML-length review body — the server's expansion of the head's
   *  concise judgment (grounded reasoning, [Summary]/[S&W]/[Questions]). */
  body?: string;
  /** Venue review-form facets — live backend only; the mock omits them and
   *  the UI must tolerate their absence. */
  confidence?: number;
  soundness?: number;
  presentation?: number;
  contribution?: number;
  strengths?: string[];
}

export type CommentSeverity = "major" | "minor" | "question";

/** A structured review issue — the anchor replies and revisions point at. */
export interface ReviewComment {
  id: string;
  cycle: number;
  /** Which reviewer raised it — targeted replies go back to them. */
  reviewer: string;
  severity: CommentSeverity;
  section: string;
  body: string;
}

/** One message in the rebuttal thread (chat). */
export interface CycleMessage {
  id: string;
  role: "author" | "reviewer" | "ac";
  author: string;
  body: string;
  /** A ReviewComment id (per-comment reply) or a CycleMessage id. */
  replyTo?: string;
  /** Set when the pending revised draft was delivered with this message. */
  attachment?: "revised-draft";
  createdAt: string;
}

/** One AI-proposed revision the author can allow or deny individually.
 *  `before` is an exact substring of the manuscript; `after` replaces it. */
export interface RevisionHunk {
  id: string;
  before: string;
  after: string;
  rationale: string;
  commentIds: string[];
  decision?: "allowed" | "denied";
}

export interface LoopScore {
  cycle: number;
  /** 0–100 — revealed only when the meta-review is written. */
  score: number;
  selectThreshold: number;
  gradeTier: "reject" | "poster" | "spotlight" | "oral" | "notable-top-5%";
  attributions: Array<{ feature: string; weight: number; evidence?: string[] }>;
  layers: number[];
}

export interface LoopManuscript {
  kind: "text" | "pdf";
  text?: string;
  fileName?: string;
  url?: string;
}

export interface LoopCycle {
  cycle: number;
  createdAt: string;
  manuscript: LoopManuscript;
  reviews: ReviewerReview[];
  comments: ReviewComment[];
  thread: CycleMessage[];
  /** AI revision draft awaiting per-hunk decisions. */
  pendingRevision?: { hunks: RevisionHunk[]; createdAt: string };
  /** Revised manuscript (applied hunks or manual edits) — rides as an
   *  attachment on the author's next message and seeds the next cycle. */
  draftManuscript?: string;
  /** The hunk allow/deny log — pre-fills the composer as draft rebuttal text. */
  revisionNote?: string;
  /** Set at finalize — the AC synthesis of reviews + discussion. */
  metaReview?: string;
  /** Set at finalize — score exists only alongside the meta-review. */
  score?: LoopScore;
  decision?: CycleDecision;
  /** S6 synthesis: what capped the score this cycle (incl. the
   *  selected-but-not-best-paper gap) and what to change next cycle. */
  deficiency?: {
    headline: string;
    targetBand: string;
    items: Array<{ feature: string; why: string; action: string }>;
  };
  /** OpenReview-style Program Chairs post — live backend only (finalize). */
  decisionPost?: { decision: string; comment: string; createdAt: string };
  /** Corpus-measured recency-calibration audit — live backend only. */
  fieldContext?: {
    note: string;
    term?: string;
    maturity?: number;
    early_pct?: number;
    recent_pct?: number;
    mature_terms?: string[];
    rising_terms?: string[];
  };
}

export interface LoopPaper {
  id: string;
  title: string;
  abstract: string;
  status: LoopStatus;
  currentCycle: number;
  cycles: LoopCycle[];
  createdAt: string;
}

export interface SubmitLoopPaperInput {
  title: string;
  text?: string;
  file?: File;
}

/** A long agent operation running server-side; the UI polls it and renders
 *  the event stream (harness steps + Claude thinking summaries) live. */
export interface AgentJobEvent {
  t: string;
  kind: "step" | "thinking";
  text: string;
}
export type AgentOp = "submit" | "reply" | "revision-draft" | "finalize" | "resubmit";
export interface AgentJob {
  id: string;
  op: AgentOp;
  status: "running" | "done" | "error";
  events: AgentJobEvent[];
  paperId?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Mock simulation (no backend)
// ---------------------------------------------------------------------------

import { deleteStoredPaper, loadStoredPapers, persistPaper } from "./loopStorage";

const BASE = import.meta.env.VITE_RALPH_API_URL as string | undefined;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
let seq = 1;

export const SELECT_THRESHOLD = 88;

const FALLBACK_REVIEWS: Array<[string, number, string, Array<[CommentSeverity, string, string]>]> = [
  [
    "Reviewer 1", 4,
    "The core idea is genuinely interesting and the writing is clear, but the central claim is not isolated from the auxiliary loss — without a head-only ablation I cannot attribute the gains.",
    [
      ["major", "Method", "The central claim is not isolated: the gains could come from the auxiliary loss rather than the proposed head. Add an ablation that removes only the head."],
      ["question", "Method", "How does the approach behave when the score head is trained on a different venue distribution?"],
    ],
  ],
  [
    "Reviewer 2", 5,
    "Solid contribution with a plausible mechanism. My main reservation is experimental rigor: single-seed results and a missing strong baseline make the tables hard to trust.",
    [
      ["major", "Experiments", "All results use a single seed. Report mean ± std over ≥3 seeds for the main tables."],
      ["major", "Related work", "The comparison omits the strongest recent baseline; without it the improvement claim is not supported."],
    ],
  ],
  [
    "Reviewer 3", 4,
    "Several figures are illegible at print size and the contribution list overstates the theory result. The method may be sound, but presentation undermines the evidence.",
    [
      ["minor", "Figures", "Figure 2 axis labels are unreadable at print size; regenerate at higher resolution."],
      ["minor", "Writing", "Section 3 mixes notation (x vs x̃) — unify and add a notation table."],
    ],
  ],
];

const CYCLE_SCORES = [63, 79, 91, 96];

function tierFor(score: number): LoopScore["gradeTier"] {
  if (score >= 95) return "notable-top-5%";
  if (score >= 88) return "oral";
  if (score >= 78) return "spotlight";
  if (score >= 60) return "poster";
  return "reject";
}

function layersFor(score: number): number[] {
  const base = 0.2 + 0.6 * (score / 100);
  return Array.from({ length: 12 }, (_, i) => {
    const wobble = ((i * 37 + score * 13) % 10) / 100;
    const bottleneck = i === 7 ? 0.15 : 0;
    return Math.min(1, Math.round((base * (0.7 + 0.03 * i) + bottleneck + wobble) * 100) / 100);
  });
}

function attributionsFor(text: string | undefined, score: number): LoopScore["attributions"] {
  const ev = (re: RegExp) => {
    if (!text) return [];
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 30 && re.test(s))
      .slice(0, 2);
  };
  return [
    { feature: "novelty of contribution", weight: Math.round((0.2 + score / 500) * 100) / 100, evidence: ev(/propose|novel|new|contribution/i) },
    { feature: "clarity of writing", weight: 0.18, evidence: ev(/abstract|section|we (study|present|show)/i) },
    { feature: "empirical breadth", weight: Math.round(((score - 70) / 100) * 100) / 100, evidence: ev(/benchmark|dataset|experiment/i) },
    { feature: "ablation completeness", weight: Math.round(((score - 85) / 120) * 100) / 100, evidence: ev(/ablation|isolat|seed/i) },
  ];
}

function buildCycle(
  paperId: string,
  cycleNo: number,
  manuscript: LoopManuscript,
  reviewSet: typeof FALLBACK_REVIEWS = FALLBACK_REVIEWS,
): LoopCycle {
  const reviews: ReviewerReview[] = [];
  const comments: ReviewComment[] = [];
  let ci = 0;
  reviewSet.forEach(([reviewer, rating, summary, cs], i) => {
    reviews.push({ id: `${paperId}_cy${cycleNo}_r${i}`, reviewer, rating, summary });
    for (const [severity, section, body] of cs) {
      comments.push({ id: `${paperId}_cy${cycleNo}_c${ci++}`, cycle: cycleNo, reviewer, severity, section, body });
    }
  });
  return { cycle: cycleNo, createdAt: now(), manuscript, reviews, comments, thread: [] };
}

function pushMsg(cyc: LoopCycle, role: CycleMessage["role"], author: string, body: string, replyTo?: string): CycleMessage {
  const m: CycleMessage = { id: `m${cyc.thread.length}_${cyc.cycle}`, role, author, body, createdAt: now() };
  if (replyTo) m.replyTo = replyTo;
  cyc.thread.push(m);
  return m;
}

function mockHunks(cyc: LoopCycle): RevisionHunk[] {
  const text = cyc.manuscript.text ?? "";
  const sents = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 25);
  return sents.slice(0, 3).map((s, i) => ({
    id: `h${i}`,
    before: s,
    after: s.replace(/\.$/, "") + ", which we scope explicitly and support with a seed-reported ablation in the revision.",
    rationale: "Scopes the claim and ties it to the reviewers' rigor concerns.",
    commentIds: cyc.comments[i % Math.max(cyc.comments.length, 1)] ? [cyc.comments[i % cyc.comments.length].id] : [],
  }));
}

function mockFinalize(cyc: LoopCycle, opts?: { score?: number; metaText?: string }) {
  const score = opts?.score ?? CYCLE_SCORES[Math.min(cyc.cycle - 1, CYCLE_SCORES.length - 1)];
  const applied = cyc.pendingRevision?.hunks.filter((h) => h.decision === "allowed").length ?? 0;
  const denied = cyc.pendingRevision?.hunks.filter((h) => h.decision === "denied").length ?? 0;
  const meta =
    (opts?.metaText
      ? `Meta-review (cycle ${cyc.cycle}). ${opts.metaText} `
      : `Meta-review (cycle ${cyc.cycle}). The reviewers raised concerns about attribution, experimental rigor, ` +
        `and presentation. Across ${cyc.thread.length} discussion messages the authors engaged substantively, ` +
        `applying ${applied} revision(s) and declining ${denied} with stated reasons. `) +
    (score >= SELECT_THRESHOLD
      ? "The committee finds the remaining concerns narrow and recommends selection."
      : "Substantive concerns remain; the committee invites a revised resubmission — selection stays open on every future cycle.");
  cyc.metaReview = meta;
  cyc.score = {
    cycle: cyc.cycle,
    score,
    selectThreshold: SELECT_THRESHOLD,
    gradeTier: tierFor(score),
    attributions: attributionsFor(cyc.manuscript.text, score),
    layers: layersFor(score),
  };
  cyc.decision = score >= SELECT_THRESHOLD ? "accept" : "reject";
  const bands: Array<[number, string]> = [
    [60, "poster"],
    [78, "spotlight"],
    [88, "oral / selection"],
    [95, "notable-top-5% (best-paper band)"],
  ];
  const nb = bands.find(([cut]) => score < cut);
  const targetBand = nb ? `${nb[0]} (${nb[1]})` : "top of the corpus";
  const negatives = cyc.score.attributions.filter((a) => a.weight < 0).sort((a, b) => a.weight - b.weight);
  const items = negatives.slice(0, 4).map((a) => ({
    feature: a.feature,
    why: `This feature pulled the score down (${a.weight >= 0 ? "+" : ""}${a.weight.toFixed(2)}) this cycle.`,
    action: `Address ${a.feature} directly in the next revision and surface the change in the abstract.`,
  }));
  cyc.deficiency = {
    headline: items.length
      ? `The score stopped at ${score} mainly on ${items[0].feature} — the next band is ${targetBand}.`
      : `The score reached ${score}; the next band is ${targetBand}.`,
    targetBand,
    items: items.length
      ? items
      : [
          {
            feature: "empirical breadth",
            why: "No single feature dominates, but the aggregate evidence stops short of the next band.",
            action: "Broaden the evaluation and tighten claims to push into the next band.",
          },
        ],
  };
  pushMsg(cyc, "ac", "Area Chair", meta);
}

function manuscriptForSubmission(input: SubmitLoopPaperInput): LoopManuscript {
  if (input.file) {
    return {
      kind: "pdf",
      url: URL.createObjectURL(input.file),
      fileName: input.file.name,
      text: input.text?.trim() || undefined,
    };
  }
  return { kind: "text", text: input.text ?? "" };
}

const loopPapers: LoopPaper[] = [];

/** Demo seeds are code-defined; deleting one uses a per-paper localStorage tombstone.
 *  (The legacy all-papers key "sail-demo-hidden" only hides the old single demo id.) */
const DEMO_HIDDEN_KEY = "sail-demo-hidden";
export const DEMO_ID_PREFIX = "lp_demo";
function demoHidden(id: string): boolean {
  try {
    if (localStorage.getItem(`${DEMO_HIDDEN_KEY}:${id}`) === "1") return true;
    return id === "lp_demo" && localStorage.getItem(DEMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}
function hideDemoSeed(id: string) {
  try {
    localStorage.setItem(`${DEMO_HIDDEN_KEY}:${id}`, "1");
  } catch {
    // in-memory removal already happened
  }
}

// --- Demo seeds ------------------------------------------------------------
// Five REAL papers (manuscripts and review content lightly adapted from the
// actual OpenReview record) shown in different loop states. The loop has no
// terminal reject: an unselected cycle always invites resubmission, so the
// states below are "selected on cycle 1", "selected on cycle 2", "mid
// discussion", "cycle 3 and still trying", and "just submitted".
(function seedDemos() {
  if (!demoHidden("lp_demo1")) {
    const ms = "# How much can language models memorize?\n\n## Abstract\n\nWe propose a new method for estimating how much a model knows about a datapoint and use it to measure the capacity of modern language models. Prior studies have struggled to disentangle memorization from generalization. We formally separate memorization into unintended memorization, the information a model contains about a specific dataset, and generalization, the information it contains about the true data-generation process. Eliminating generalization completely lets us compute total memorization, an estimate of model capacity: approximately 3.6 bits per parameter for GPT-style models. Training hundreds of transformers from 500K to 1.5B parameters on datasets of increasing size, we observe that models memorize until capacity fills, at which point unintended memorization decreases as models begin to generalize, and we produce scaling laws relating capacity and data size to membership inference.\n\n## 1. Introduction\n\nHow much does a language model know about its training data, and how much of that knowledge is tied to individual examples rather than the underlying distribution? Existing extraction-based definitions conflate the two. A model trained on the sample \"Q: What is 2^100? A: 1267650600228229401496703205376\" that compresses this sequence well is flagged as memorizing it - yet a capable model should compute 2^100 on its own, which reflects generalization, not memorization. Contrast this with \"John Smith scored 147 points in the 2019 regional bowling championship,\" whose details no reference model can account for.\n\nWe separate unintended memorization, the information a model stores about a specific dataset, from generalization, its knowledge of the true data-generation process. When generalization is eliminated entirely - by training on uniformly random data - total memorization can be computed exactly, yielding an estimate of capacity. Unintended memorization falls once capacity fills and generalization takes over.\n\n## 2. A Formal Framework for Memorization\n\nWe define total memorization as the mutual information between the trained model and its dataset, and decompose it relative to a reference model into intended memorization (the uncertainty reduction the reference already achieves) and unintended memorization (the additional reduction the trained model contributes). Since Shannon entropy cannot be estimated from a single model and dataset, we operationalize the definitions via Kolmogorov complexity, estimating compression lengths from model likelihoods with arithmetic coding; the two notions agree in expectation (Proposition 4).\n\n## 3. Measuring Model Capacity\n\nTraining on uniformly random sequences removes generalization, so measured memorization equals stored information: across hundreds of GPT-style transformers trained to saturation (10^6 steps), memorization plateaus at approximately 3.6 bits per parameter, with fp32 training yielding modestly higher capacity than bf16.\n\n## 4. Real Text, Double Descent, and Membership Inference\n\nOn deduplicated FineWeb with strict train/test separation, unintended memorization grows with dataset size until capacity fills, then declines as models generalize - and double descent begins exactly when the information in the dataset exceeds model capacity (Figure 3). A scaling law fit on models up to 20M parameters predicts membership-inference F1 on GPT-2 XL (1.5B) within 1.5 points (Table 2); residual memorization concentrates on rare, out-of-distribution tokens.\n\n## Limitations\n\nReal-text measurements depend on the reference model (a 1B-parameter model trained on a wider distribution); our largest trained models remain small relative to production LLMs, though predictions extrapolate accurately to 1.5B parameters.";
    const paper: LoopPaper = {
      id: "lp_demo1", title: "How much can language models memorize?", abstract: "Separates memorization into unintended memorization and generalization, measures GPT-style capacity at ~3.6 bits per parameter, and derives scaling laws for membership inference.",
      status: "decided", currentCycle: 1, cycles: [], createdAt: "2026-07-12T09:00:00Z",
    };
    const c1 = buildCycle(paper.id, 1, { kind: "text", text: ms }, [
    ["Reviewer 1", 7, "Proposes a reference-model-based notion of unintended memorization separating sample-specific storage from generalization, estimates capacity via controlled random-data experiments, and connects memorization to double descent and membership inference. The synthetic-data component is strongest: entropy is exactly known and a stable bits-per-parameter estimate emerges across architectures.", [["major" as CommentSeverity, "Method", "The central real-text measurement depends on an oracle: a larger reference model trained longer on a wider distribution. Without a sensitivity analysis over the reference-model choice, the headline unintended-memorization quantity on real text remains heuristic rather than cleanly identified."], ["minor" as CommentSeverity, "Experiments", "The extraction study relies on greedy decoding over prefixes, which does not reflect realistic generation settings; the claim that remaining train-set extraction is entirely attributable to generalization should be tempered or tested against probabilistic extraction (Hayes et al., 2025)."]]],
    ["Reviewer 2", 7, "Develops an information-theoretic framework distinguishing intended memorization (generalization) from unintended memorization, approximated via Kolmogorov complexity and arithmetic coding. Experiments on random sequences and FineWeb reveal a clear capacity limit, explain double descent through the data-to-capacity ratio, and show memorization concentrates on rare tokens.", [["major" as CommentSeverity, "Method", "The claim that no generalization is stored when training on uniformly random data is intuitively reasonable but never formally stated or proved, and the capacity estimate rests on it. Relatedly, Definition 5 computes capacity over varying sizes of X where X is a distribution - what does the size of a distribution mean here?"], ["minor" as CommentSeverity, "Writing", "Nonstandard notation reduces readability - mutual information is written I(X, Y) instead of I(X; Y), conditionals as I(X, Y; theta) - and the proof of Proposition 1 is too brief; the first inequality is not as immediate as suggested and needs intermediate steps."]]],
    ["Reviewer 3", 8, "An elegant, well-motivated study: the framework is grounded in information theory so its quantities can be measured with established tools, and results are strikingly consistent across hundreds of model configurations. The connection to double descent and grokking provides a unifying narrative, and findings such as capacity saturation are genuinely useful for model training.", [["question" as CommentSeverity, "Method", "How large is the ground-truth reference model, and what happens when the trained model's size approaches it? Presumably the reference begins to underperform the target on some examples, and generalization would start being counted as unintended memorization."], ["minor" as CommentSeverity, "Experiments", "The largest trained model is still small relative to commonly used LLMs; the scaling-law extrapolation to GPT-2 XL is encouraging, but capacity saturation at ~3.6 bits per parameter is only directly verified at modest scale."]]],
  ]);
    const a1 = pushMsg(c1, "author", "Author", "We agree the reference model shifts the absolute measurement; relative comparisons remain informative, and ablations with 1B and 500M references change the slope of decline but leave the saturation point nearly unchanged. On scale: laws fit on models up to 20M parameters predict GPT-2 XL membership-inference F1 within 1.5 points.", c1.comments[0]?.id);
    pushMsg(c1, "reviewer", c1.reviews[0].reviewer, "Thanks - my concerns are addressed and my positive score stands. One lingering doubt: since cross-entropy gaps between models are predictable from scaling laws, is the fixed capacity-ratio line in Fig. 3 a Kaplan-style law with transformed axes? An experiment ruling that out would help.", a1.id);
    mockFinalize(c1, { score: 92, metaText: "Reviewers converged that this is a significant, technically solid contribution whose concerns about the oracle reference model and limited model size were addressed in rebuttal, meriting acceptance as a spotlight." });
    paper.cycles = [c1];
    loopPapers.push(paper);
  }
  if (!demoHidden("lp_demo2")) {
    const ms = "# AlphaEdit: Null-Space Constrained Knowledge Editing for Language Models\n\n## Abstract\n\nLarge language models (LLMs) often exhibit hallucinations, producing incorrect or outdated knowledge, so model editing methods have emerged to enable targeted updates. A prevailing paradigm is the locating-then-editing approach, which first locates influential parameters and then edits them by introducing a perturbation. While effective, this perturbation inevitably disrupts the originally preserved knowledge, especially in sequential editing scenarios. We introduce AlphaEdit, which projects the perturbation onto the null space of the preserved knowledge before applying it to the parameters. We prove this projection keeps post-edited outputs unchanged on preserved knowledge, mitigating disruption. Experiments on LLaMA3, GPT2-XL, and GPT-J show that AlphaEdit boosts most locating-then-editing methods by an average of 36.7% with a single line of additional code.\n\n## 1. Introduction\n\nLarge language models have demonstrated strong capability to store extensive knowledge during pre-training and recall it during inference. Despite this, they frequently exhibit hallucinations, producing incorrect or outdated information. While fine-tuning with updated knowledge offers a straightforward solution, it is often prohibitively time-consuming. Model editing methods have thus emerged, updating target knowledge while preserving the rest. Broadly, these approaches fall into two categories: parameter-modifying methods, which directly adjust a small subset of parameters, and parameter-preserving methods, which integrate additional modules without altering the original parameters.\n\nTo address the imbalance between the knowledge-update error e1 and the knowledge-preservation error e0 in this paradigm, we remove e0 from the objective, so the model focuses solely on minimizing e1. To avoid overfitting to updated knowledge, we project the solution into the null space of the preserved knowledge before applying it to the parameters. This keeps the distribution of hidden representations invariant after editing, so the post-edited LLM reduces e1 while keeping e0 near zero, alleviating model forgetting and collapse. We term the method AlphaEdit, a simple yet effective editing approach with a null-space constraint.\n\n## 2. Preliminary\n\nLocating-then-editing methods treat a feed-forward layer as a linear associative memory W mapping key matrices K to value matrices V; a perturbation Delta is solved to fit new pairs (K1, V1) while an extra error term on preserved pairs (K0, V0) imperfectly guards prior outputs.\n\n## 3. Method\n\nAlphaEdit builds a projection matrix P from the SVD of the covariance matrix K0 K0^T (whose null space equals that of K0), so the applied update Delta P satisfies (W + Delta P) K0 = W K0 = V0 exactly; the sequential objective adds regularizers on Delta P and on previously edited knowledge, and its closed-form solution differs from MEMIT by one line of code applying P.\n\n## 4. Experiments\n\nOn sequential editing of 2,000 samples (batch size 100) from Counterfact and ZsRE across GPT2-XL (1.5B), GPT-J (6B), and LLaMA3 (8B), AlphaEdit surpasses FT, MEND, ROME, MEMIT, PRUNE, and RECT on nearly all metrics, improving Efficacy by 12.54% and Generalization by 16.78% on average over the best baseline (32.85% and 30.60% on LLaMA3), with an 18.33% Fluency gain on GPT2-XL. Adding the one-line projection to MEMIT, PRUNE, and RECT yields average gains of 28.24% in editing capability and 42.65% in general capability on GLUE tasks.\n\n## Limitations\n\nApplicability to multi-modal LLMs and large reasoning models remains unexplored; future work could extend the null-space projection to broader base models and to enhancing specific capabilities without degrading others.";
    const paper: LoopPaper = {
      id: "lp_demo2", title: "AlphaEdit: Null-Space Constrained Knowledge Editing for Language Models", abstract: "Null-space projection for LLM knowledge editing: edits provably leave preserved knowledge unchanged, boosting locate-then-edit methods by an average of 36.7% with one line of code.",
      status: "decided", currentCycle: 2, cycles: [], createdAt: "2026-07-12T08:00:00Z",
    };
    const c1 = buildCycle(paper.id, 1, { kind: "text", text: ms }, [
    ["Reviewer 1", 6, "Post-editing typically disrupts knowledge an LLM already stores. AlphaEdit projects edit perturbations onto the null space of preserved-knowledge keys so old associations are provably untouched, and experiments show markedly smaller hidden-representation shift between pre- and post-edited models than MEMIT-style baselines. The write-up is clear and the research questions well chosen.", [["major" as CommentSeverity, "Experiments", "The paper never analyzes how performance correlates with the amount of preserved-knowledge data used to build K0. How much data does AlphaEdit need to work well? An isolation ablation shrinking the K0 corpus (e.g., to 50% and 10% of its size) is needed to show whether Specificity degrades gracefully."], ["minor" as CommentSeverity, "Figures", "In Figure 5 the pre- and post-edit distributions are difficult to set apart due to the color choice; two contrasting colors as in the MEMIT plots would help. The y-label of Figure 7(a), 'categories of knowledge', is also never explained in the text."]]],
    ["Reviewer 2", 5, "AlphaEdit improves locate-then-edit knowledge updating by projecting the parameter update onto the null space of preserved knowledge, reducing interference with a minimal code change. Results on GPT2-XL, GPT-J, and LLaMA3 show gains in efficacy, generalization, specificity, fluency, and consistency, but the evaluation omits several recent editing methods and covers a narrow set of models.", [["major" as CommentSeverity, "Experiments", "Recent methods are missing from the comparison: SERAC, GRACE, InstructEdit, and MELO are not evaluated, and there are no results on the KnowEdit dataset. Please add these baselines or argue why they were excluded. Testing only GPT2-XL, GPT-J, and LLaMA3 is also limited; results on models such as Gemma or Phi would strengthen the generality claim."], ["question" as CommentSeverity, "Method", "Accurate null-space projection relies on an SVD of the high-dimensional matrix K0 K0^T. How does this computation scale as model size or the preserved-knowledge base grows, and what is the practical overhead relative to MEMIT at LLaMA3 scale?"]]],
    ["Reviewer 3", 6, "The paper targets sequential knowledge editing: repairing wrong facts while keeping the rest intact. The proposed null-space constraint performs comparably to prior work for single edits and short sequences but dramatically better on long ones. The paper is well written and easy to follow, though notational lapses and one design choice around sequential solving need clarification.", [["question" as CommentSeverity, "Method", "Why must sequential editing be solved truly sequentially as in Eqn. 12? One could restart from the original model and treat the union of all previous and current edits as K1 in Eqn. 11; Figure 4 suggests this might perform even better. Please discuss or ablate this alternative."], ["minor" as CommentSeverity, "Writing", "Line 173 states 'B is in the null space of B' where A is meant; in Eqn. 7 the projected perturbation is still denoted Delta, conflating it with the unprojected one; and the meaning of 'consistent' at line 193 is unclear. These clarity issues should be fixed in revision."]]],
  ]);
    const a1 = pushMsg(c1, "author", "Author", "We added a K0-size ablation (10-100% of the corpus): Efficacy and Generalization drop under 5% even at 10%, while Specificity falls 11.8%. We also added SERAC, GRACE, MELO, and InstructEdit baselines plus KnowEdit, LEME, and MQuAKE results, and fixed the line-174 typo and figure labels.", c1.comments[0]?.id);
    pushMsg(c1, "reviewer", c1.reviews[0].reviewer, "The K0 ablation resolves my main concern, and the new memory-based baselines make the comparison convincing. Please fold the Figure 7(a) axis explanation and the sequential-vs-batch discussion into the camera-ready; I have no remaining critical concerns and am raising my score.", a1.id);
    c1.pendingRevision = { hunks: mockHunks(c1).map((h, i) => ({ ...h, decision: i === 0 ? "allowed" : "denied" })), createdAt: now() };
    const applied = c1.pendingRevision.hunks[0];
    c1.draftManuscript = (c1.manuscript.text ?? "").replace(applied.before, applied.after);
    const rv = pushMsg(c1, "author", "Author", `We revised the manuscript as follows: (1) ${applied.rationale}`);
    rv.attachment = "revised-draft";
    mockFinalize(c1, { score: 79 });
    const c2 = buildCycle(paper.id, 2, { kind: "text", text: c1.draftManuscript }, [
    ["Reviewer 1", 8, "Post-editing typically disrupts knowledge an LLM already stores. AlphaEdit projects edit perturbations onto the null space of preserved-knowledge keys so old associations are provably untouched, and experiments show markedly smaller hidden-representation shift between pre- and post-edited models than MEMIT-style baselines. The write-up is clear and the research questions well chosen.", [["major" as CommentSeverity, "Experiments", "The paper never analyzes how performance correlates with the amount of preserved-knowledge data used to build K0. How much data does AlphaEdit need to work well? An isolation ablation shrinking the K0 corpus (e.g., to 50% and 10% of its size) is needed to show whether Specificity degrades gracefully."], ["minor" as CommentSeverity, "Figures", "In Figure 5 the pre- and post-edit distributions are difficult to set apart due to the color choice; two contrasting colors as in the MEMIT plots would help. The y-label of Figure 7(a), 'categories of knowledge', is also never explained in the text."]]],
    ["Reviewer 2", 7, "AlphaEdit improves locate-then-edit knowledge updating by projecting the parameter update onto the null space of preserved knowledge, reducing interference with a minimal code change. Results on GPT2-XL, GPT-J, and LLaMA3 show gains in efficacy, generalization, specificity, fluency, and consistency, but the evaluation omits several recent editing methods and covers a narrow set of models.", [["major" as CommentSeverity, "Experiments", "Recent methods are missing from the comparison: SERAC, GRACE, InstructEdit, and MELO are not evaluated, and there are no results on the KnowEdit dataset. Please add these baselines or argue why they were excluded. Testing only GPT2-XL, GPT-J, and LLaMA3 is also limited; results on models such as Gemma or Phi would strengthen the generality claim."], ["question" as CommentSeverity, "Method", "Accurate null-space projection relies on an SVD of the high-dimensional matrix K0 K0^T. How does this computation scale as model size or the preserved-knowledge base grows, and what is the practical overhead relative to MEMIT at LLaMA3 scale?"]]],
    ["Reviewer 3", 8, "The paper targets sequential knowledge editing: repairing wrong facts while keeping the rest intact. The proposed null-space constraint performs comparably to prior work for single edits and short sequences but dramatically better on long ones. The paper is well written and easy to follow, though notational lapses and one design choice around sequential solving need clarification.", [["question" as CommentSeverity, "Method", "Why must sequential editing be solved truly sequentially as in Eqn. 12? One could restart from the original model and treat the union of all previous and current edits as K1 in Eqn. 11; Figure 4 suggests this might perform even better. Please discuss or ablate this alternative."], ["minor" as CommentSeverity, "Writing", "Line 173 states 'B is in the null space of B' where A is meant; in Eqn. 7 the projected perturbation is still denoted Delta, conflating it with the unprojected one; and the meaning of 'consistent' at line 193 is unclear. These clarity issues should be fixed in revision."]]],
  ]);
    mockFinalize(c2, { score: 91, metaText: "All reviewers converged on acceptance after the rebuttal added three datasets, two base LLMs, and four baselines, praising an elegant, theoretically well-designed method that sharply reduces impact on general capabilities." });
    paper.cycles = [c1, c2];
    loopPapers.push(paper);
  }
  if (!demoHidden("lp_demo3")) {
    const ms = "# Superposition Yields Robust Neural Scaling\n\n## Abstract\n\nThe success of today's large language models (LLMs) depends on the observation that larger models perform better, yet the origin of this neural scaling law remains unclear. We propose that representation superposition, meaning that LLMs represent more features than they have dimensions, can be a key contributor to loss and cause neural scaling. Based on Anthropic's toy model, we use weight decay to control the degree of superposition and study how loss scales with model size. When superposition is weak, loss follows a power law only if data feature frequencies are power-law distributed. Under strong superposition, loss generically scales inversely with model dimension across a broad class of frequency distributions, due to geometric overlaps between representation vectors. Open-sourced LLMs operate in the strong superposition regime, and the Chinchilla scaling laws are consistent with this behavior, identifying superposition as a central driver of neural scaling laws.\n\n## 1. Introduction\n\nThe success of large language models has been driven by the observation that increasing model size, data, and compute consistently improves performance. Across tasks including language understanding, math, and code generation, larger models achieve lower loss, higher accuracy, and greater generalization. This trend, known as neural scaling laws, holds across model families and architectures, raising the question of why such universal patterns emerge.\n\nThe power-law loss with model size is central to the design and theoretical understanding of large-scale machine learning systems, yet its origin remains inconclusive. Proposed explanations include improved function or manifold approximation and enhanced representation or skill learning in larger models. In the infinite-data limit, many of these predict power-law loss decay only if the data distribution itself follows a power law, with exponents sensitive to data properties; their connection to actual LLM behavior also needs further exploration.\n\n## 2. Methods\n\nWe adopt Anthropic's toy model of superposition (an autoencoder) whose inputs activate feature i with frequency p_i, and add a decoupled weight-decay (or growth) term gamma to AdamW that tunes superposition: large positive gamma yields weak superposition, while small or negative gamma drives nearly all n features to be represented. We fix n = 1000, vary model dimension m from 10 to 100, sweep gamma from -1 to 1, and fit test losses as a power law in 1/m with exponent alpha_m.\n\n## 3. Results\n\nAt weak superposition, loss equals the summed frequency of ignored features, so power-law data (p_i decaying as 1/i^alpha, alpha > 1) gives alpha_m close to alpha - 1: power law in, power law out. At strong superposition, represented vectors approach an equal-angle-tight-frame-like geometry whose mean squared overlap scales as 1/m, yielding a robust alpha_m near 1 for flat frequencies and about 2(alpha - 1) for skewed ones. Across Opt, GPT2, Qwen, and Pythia (about 100M to 70B parameters), LM-head overlaps follow 1/m and the fitted loss exponent is alpha_m = 0.91 +/- 0.04, with Chinchilla data implying 0.88 +/- 0.06.\n\n## 4. Related Works\n\nPrior accounts — data-manifold fitting, power-law-distributed skills or quanta, and kernel spectra — conceptually fall in the weak superposition regime, where exponents depend sensitively on data structure; the strong-superposition mechanism here is complementary, arising from intrinsic model geometry.\n\n## Limitations\n\nThe analysis rests on a toy model we cannot solve analytically, and the LLM connection uses embedding and LM-head statistics only; dataset-size and training-step scaling, and parsing loss in transformer layers, are left to future work.";
    const paper: LoopPaper = {
      id: "lp_demo3", title: "Superposition Yields Robust Neural Scaling", abstract: "Proposes representation superposition as a driver of neural scaling laws: strong superposition yields robust 1/width loss scaling in toy models, matching LLM measurements (alpha_m = 0.91 +/- 0.04).",
      status: "in_discussion", currentCycle: 1, cycles: [], createdAt: "2026-07-12T10:00:00Z",
    };
    const c1 = buildCycle(paper.id, 1, { kind: "text", text: ms }, [
    ["Reviewer 1", 6, "Argues that superposition drives neural scaling, using a weight-decay-controlled variant of Anthropic's toy autoencoder. Weak superposition yields power-law loss only for power-law data (alpha_m near alpha - 1), while strong superposition gives a robust 1/m law from ETF-like geometry; LM-head analysis suggests real LLMs sit in the strong regime with alpha_m = 0.91.", [["major" as CommentSeverity, "Method", "The claim that strongly represented vectors form an ETF-like configuration is not convincingly validated: the empirical count of strongly represented features does not match the m^2/2 bound in Figure 6c, and low overlap variance alone is weak evidence. The loss estimate also assumes zero outputs for unrepresented features, ignoring the learned bias equal to the feature mean; please compute with the correct mean values."], ["minor" as CommentSeverity, "Writing", "The monolithic 4.5-page results section is dense and hard to navigate, with claims scattered throughout. Restructure with subsections, define 'represented' versus 'well-represented' and justify the 0.5 norm threshold explicitly, and add discussion of how this explanation relates to existing scaling-law theories."]]],
    ["Reviewer 2", 6, "Analyzes scaling laws through superposition in a toy autoencoder where weight decay switches between weak and strong regimes. Scaling is robust under strong superposition and fragile, data-dependent under weak superposition; head statistics are then used to argue large LLMs fall in the strong regime. The toy analysis is comprehensive and tells a clean story.", [["major" as CommentSeverity, "Experiments", "The real-model section is much weaker than the toy analysis. Evidence that LLMs occupy the strong superposition regime rests on a brief statistical check of the LM head; small-scale experiments on real data, or a more detailed mechanistic analysis of actual LLMs, are needed to close the theory-practice gap."], ["question" as CommentSeverity, "Method", "Tuning weight decay changes both superposition and scaling behavior, which establishes a correlation. What justifies the causal claim that superposition produces the scaling law? And since correlated features are essential in real-world data, how would feature correlation change the model and its predictions?"]]],
    ["Reviewer 3", 7, "A compelling, novel link between superposition and scaling laws: interference under strong superposition yields 1/width loss scaling with a geometric ETF explanation, and LLM unembedding analysis matches the predicted exponent of 1, consistent with Chinchilla. Experiment-rich, clearly written, and potentially actionable for architecture design.", [["question" as CommentSeverity, "Method", "Defining representation learning strictly as token embedding seems unusual, since intermediate activations are also representations capturing composed features. Would combinatorially many middle-layer features make superposition loss dominate the parsing loss as well, and what experiment would most directly falsify the theory?"], ["minor" as CommentSeverity, "Related work", "Natural language is itself power-law distributed, so earlier data-distribution-based theories remain plausible; please discuss how compatible or complementary your mechanism is with them. Also acknowledge that encouraging superposition for performance may harm mechanistic interpretability and AI safety."]]],
  ]);
    const a1 = pushMsg(c1, "author", "Author", "We thank the reviewers. We will restructure Results into weak/strong/LLM subsections with explicit definitions. On geometry: we claim ETF-like, not exact ETF — mean overlaps match the kappa bound, and rugged loss landscapes explain residual variance. We will use the unsimplified loss with bias terms and add embedding and token-correlation analyses.", c1.comments[0]?.id);
    pushMsg(c1, "reviewer", c1.reviews[0].reviewer, "Most of my concerns are addressed. I still recommend computing the loss with the correct mean values in Figure 5a and clarifying why strongly represented features exceed the m^2/2 bound at small m. If the restructuring and these discussions land in the paper, I am prepared to raise my score.", a1.id);
    paper.cycles = [c1];
    loopPapers.push(paper);
  }
  if (!demoHidden("lp_demo4")) {
    const ms = "# Semi-Supervised Blind Quality Assessment with Confidence-quantifiable Pseudo-label Learning for Authentic Images\n\n## Abstract\n\nThis paper presents CPL-IQA, a semi-supervised blind image quality assessment (BIQA) framework for authentic distortion scenarios. To address limited labeled data in IQA, the approach leverages confidence-quantifiable pseudo-label learning to utilize unlabeled authentically distorted images. The framework first converts MOS labels to vector labels via entropy minimization, then iteratively alternates between model training and label optimization. Key innovations include a manifold assumption-based label optimization strategy and a confidence learning method for pseudo-labels, enhancing reliability and mitigating outlier effects. Experiments demonstrate superior performance on real-world distorted image datasets without requiring additional supervision or network complexity.\n\n## 1. Introduction\n\nTo address the scarcity of labeled authentic data, researchers explore unsupervised or semi-supervised BIQA methods, which utilize unlabeled images to boost quality prediction. The intuitive unsupervised idea is to pre-train on large synthetically distorted databases with contrastive learning and fine-tune on an authentic database, yet performance on authentic images remains unsatisfactory. Semi-supervised works based on knowledge distillation require the score distribution of each image, while only MOS labels are available in most authentic datasets (such as SPAQ), and images with similar MOS values may correspond to a variety of score distributions. Moreover, the latest semi-supervised methods SSLIQA and SS-IQA both require additional network branches and extra data during training, leading to higher training costs.\n\nTherefore, we propose a novel semi-supervised BIQA framework named CPL-IQA based on label propagation (LP), which can be trained end-to-end on a single-branch network without extra inputs. LP first constructs a nearest neighbor graph in feature space under the manifold hypothesis, then derives pseudo-labels of unlabeled samples from the graph and the limited labeled samples. However, label propagation is skilled at handling vector-label data, whereas the MOS label in IQA datasets is a scalar. CPL-IQA must therefore (1) reasonably convert scalar MOS labels into vector labels for LP, and (2) effectively predict pseudo-labels of unlabeled images and their confidence levels for model training.\n\n## 2. Related Works\n\nTraditional BIQA methods rely on hand-crafted statistical features, while DL-based methods are data hungry; unsupervised contrastive approaches transfer poorly to authentic distortions, and semi-supervised SSLIQA and SS-IQA demand multi-branch networks and auxiliary datasets.\n\n## 3. Methods\n\nCPL-IQA normalizes MOS to [1, 100], converts each scalar label into a 100-dimensional vector label by entropy minimization, then alternates model training and label optimization: a kNN graph (k = 10, built with FAISS) over 256-dimensional ResNet-101 features propagates labels via a closed-form solution (gamma = 0.99), and an entropy-based confidence weight down-weights unreliable pseudo-labels in the loss.\n\n## 4. Experiments\n\nOn KonIQ-10K with a 1:3:1 labeled/unlabeled/test split, CPL-IQA attains PLCC 0.873 and SRCC 0.845, surpassing sixteen competitors including two-branch SSLIQA (0.867/0.841); cross-dataset tests reach PLCC 0.777 on LIVE-C and 0.772 on NNID, and ablations show confidence weighting lifts SPAQ (1:8:1) PLCC from 0.881 to 0.896.\n\n## Limitations\n\nThe label conversion assumes annotated MOS values carry sufficiently high confidence; significant annotation noise or uneven MOS distributions can degrade pseudo-label reliability, and noise-robust extensions are left to future work.";
    const paper: LoopPaper = {
      id: "lp_demo4", title: "Semi-Supervised Blind Quality Assessment with Confidence-quantifiable Pseudo-label Learning for Authentic Images", abstract: "Semi-supervised BIQA framework using confidence-quantifiable pseudo-label learning: entropy-minimization label conversion plus manifold-based label propagation for authentically distorted images.",
      status: "in_discussion", currentCycle: 3, cycles: [], createdAt: "2026-07-12T07:00:00Z",
    };
    const c1 = buildCycle(paper.id, 1, { kind: "text", text: ms }, [
    ["Reviewer 1", 3, "The paper converts MOS labels to vector labels via entropy minimization and propagates labels over a kNN feature graph with confidence weighting. The method is sound and easy to understand, but the contribution feels incremental: label conversion is not uncommon in quality assessment, and the Figure 1 motivation appears at odds with a conversion that ignores score variance.", [["major" as CommentSeverity, "Related work", "Label conversion is common in IQA/VQA - Q-Align adopts a similar discretization. The proposed entropy-minimization conversion should be compared against existing MOS discretization schemes to demonstrate its distinction and effectiveness."], ["major" as CommentSeverity, "Experiments", "The gain over SSLIQA on KonIQ-10K is marginal (PLCC 0.873 vs 0.867), sensitivity to the labeled/unlabeled batch ratio B_L/B_U is untested, and the required two-stage training adds implementation burden with unreported training cost."]]],
    ["Reviewer 2", 4, "CPL-IQA tackles semi-supervised BIQA by converting MOS labels to vectors via entropy minimization, predicting pseudo-labels through nearest-neighbor graph construction, and alternating model training with label optimization. Results surpass existing algorithms, though comparisons with recent 2024 methods and quantitative pseudo-label analysis are missing.", [["major" as CommentSeverity, "Related work", "Recent methods are neither discussed nor compared, including Q-Align (ICML 2024), efficient transformer adaptation with local feature enhancement (CVPR 2024), and geometric order learning for BIQA (CVPR 2024)."], ["question" as CommentSeverity, "Figures", "Figure 4 compares pseudo-label and ground-truth distributions only visually; please report quantitative measures such as MAE between pseudo and GT labels, and clarify how much the pseudo-labeling process increases training time."]]],
    ["Reviewer 3", 5, "This work leverages unlabeled data for IQA training with entropy-based confidence learning to mitigate label noise. The alternation between model training and label optimization is reasonable, as pseudo-label reliability grows with model correctness. The setup on manually split annotated datasets is fair, and the method outperforms supervised, unsupervised, and semi-supervised baselines.", [["minor" as CommentSeverity, "Method", "Resizing all images to 256 x 256 may deteriorate IQA performance by altering distortion characteristics; cropping multiple patches from images at their original resolution would be preferable."], ["question" as CommentSeverity, "Writing", "In Table 10, the SRCC result of HyperIQA is higher than the proposed method but not marked in bold - is this a typo? It would also strengthen the work to train on a fully labeled dataset plus extra unlabeled data under a regular 8:2 split."]]],
  ]);
    const a1 = pushMsg(c1, "author", "Author", "We add conversion baselines: one-hot and normal-distribution simulation reach PLCC 0.803/0.832 versus our 0.873. Varying (B_L, B_U) shifts PLCC by under 0.005, and pseudo-labeling takes only 2.1% of Stage-2 time. Training on labeled KonIQ-10k plus unlabeled LIVE-C lifts test PLCC from 0.879 to 0.891. We will cite Q-Align and add all results.", c1.comments[0]?.id);
    pushMsg(c1, "reviewer", c1.reviews[0].reviewer, "Partially addressed. The fluctuation across conversion methods is odd - N-D simulation with fixed variance is roughly a smoothed version of your entropy minimization, so such sensitivity is unexpected. The claimed single-branch compatibility also remains experimentally unsupported. I keep my score.", a1.id);
    c1.pendingRevision = { hunks: mockHunks(c1).map((h) => ({ ...h, decision: "allowed" as const })), createdAt: now() };
    c1.draftManuscript = c1.pendingRevision.hunks.reduce((t, h) => t.replace(h.before, h.after), c1.manuscript.text ?? "");
    mockFinalize(c1, { score: 63 });
    const c2 = buildCycle(paper.id, 2, { kind: "text", text: c1.draftManuscript ?? ms }, [
    ["Reviewer 1", 4, "The paper converts MOS labels to vector labels via entropy minimization and propagates labels over a kNN feature graph with confidence weighting. The method is sound and easy to understand, but the contribution feels incremental: label conversion is not uncommon in quality assessment, and the Figure 1 motivation appears at odds with a conversion that ignores score variance.", [["major" as CommentSeverity, "Related work", "Label conversion is common in IQA/VQA - Q-Align adopts a similar discretization. The proposed entropy-minimization conversion should be compared against existing MOS discretization schemes to demonstrate its distinction and effectiveness."], ["major" as CommentSeverity, "Experiments", "The gain over SSLIQA on KonIQ-10K is marginal (PLCC 0.873 vs 0.867), sensitivity to the labeled/unlabeled batch ratio B_L/B_U is untested, and the required two-stage training adds implementation burden with unreported training cost."]]],
    ["Reviewer 2", 5, "CPL-IQA tackles semi-supervised BIQA by converting MOS labels to vectors via entropy minimization, predicting pseudo-labels through nearest-neighbor graph construction, and alternating model training with label optimization. Results surpass existing algorithms, though comparisons with recent 2024 methods and quantitative pseudo-label analysis are missing.", [["major" as CommentSeverity, "Related work", "Recent methods are neither discussed nor compared, including Q-Align (ICML 2024), efficient transformer adaptation with local feature enhancement (CVPR 2024), and geometric order learning for BIQA (CVPR 2024)."], ["question" as CommentSeverity, "Figures", "Figure 4 compares pseudo-label and ground-truth distributions only visually; please report quantitative measures such as MAE between pseudo and GT labels, and clarify how much the pseudo-labeling process increases training time."]]],
    ["Reviewer 3", 6, "This work leverages unlabeled data for IQA training with entropy-based confidence learning to mitigate label noise. The alternation between model training and label optimization is reasonable, as pseudo-label reliability grows with model correctness. The setup on manually split annotated datasets is fair, and the method outperforms supervised, unsupervised, and semi-supervised baselines.", [["minor" as CommentSeverity, "Method", "Resizing all images to 256 x 256 may deteriorate IQA performance by altering distortion characteristics; cropping multiple patches from images at their original resolution would be preferable."], ["question" as CommentSeverity, "Writing", "In Table 10, the SRCC result of HyperIQA is higher than the proposed method but not marked in bold - is this a typo? It would also strengthen the work to train on a fully labeled dataset plus extra unlabeled data under a regular 8:2 split."]]],
  ]);
    pushMsg(c2, "author", "Author", "We broadened the evaluation to two additional datasets and added the missing strong baseline, as requested in cycle 1.");
    mockFinalize(c2, { score: 76 });
    const c3 = buildCycle(paper.id, 3, { kind: "text", text: c1.draftManuscript ?? ms }, [
    ["Reviewer 1", 5, "The paper converts MOS labels to vector labels via entropy minimization and propagates labels over a kNN feature graph with confidence weighting. The method is sound and easy to understand, but the contribution feels incremental: label conversion is not uncommon in quality assessment, and the Figure 1 motivation appears at odds with a conversion that ignores score variance.", [["major" as CommentSeverity, "Related work", "Label conversion is common in IQA/VQA - Q-Align adopts a similar discretization. The proposed entropy-minimization conversion should be compared against existing MOS discretization schemes to demonstrate its distinction and effectiveness."], ["major" as CommentSeverity, "Experiments", "The gain over SSLIQA on KonIQ-10K is marginal (PLCC 0.873 vs 0.867), sensitivity to the labeled/unlabeled batch ratio B_L/B_U is untested, and the required two-stage training adds implementation burden with unreported training cost."]]],
    ["Reviewer 2", 6, "CPL-IQA tackles semi-supervised BIQA by converting MOS labels to vectors via entropy minimization, predicting pseudo-labels through nearest-neighbor graph construction, and alternating model training with label optimization. Results surpass existing algorithms, though comparisons with recent 2024 methods and quantitative pseudo-label analysis are missing.", [["major" as CommentSeverity, "Related work", "Recent methods are neither discussed nor compared, including Q-Align (ICML 2024), efficient transformer adaptation with local feature enhancement (CVPR 2024), and geometric order learning for BIQA (CVPR 2024)."], ["question" as CommentSeverity, "Figures", "Figure 4 compares pseudo-label and ground-truth distributions only visually; please report quantitative measures such as MAE between pseudo and GT labels, and clarify how much the pseudo-labeling process increases training time."]]],
    ["Reviewer 3", 7, "This work leverages unlabeled data for IQA training with entropy-based confidence learning to mitigate label noise. The alternation between model training and label optimization is reasonable, as pseudo-label reliability grows with model correctness. The setup on manually split annotated datasets is fair, and the method outperforms supervised, unsupervised, and semi-supervised baselines.", [["minor" as CommentSeverity, "Method", "Resizing all images to 256 x 256 may deteriorate IQA performance by altering distortion characteristics; cropping multiple patches from images at their original resolution would be preferable."], ["question" as CommentSeverity, "Writing", "In Table 10, the SRCC result of HyperIQA is higher than the proposed method but not marked in bold - is this a typo? It would also strengthen the work to train on a fully labeled dataset plus extra unlabeled data under a regular 8:2 split."]]],
  ]);
    pushMsg(c3, "author", "Author", "Third submission: this cycle adds the cross-domain generalization study reviewers asked for. We believe the remaining gap to selection is now the writing, which we have restructured.");
    paper.cycles = [c1, c2, c3];
    loopPapers.push(paper);
  }
  if (!demoHidden("lp_demo5")) {
    const ms = "# The Flexibility Trap: Rethinking the Value of Arbitrary Order in Diffusion Language Models\n\n## Abstract\n\nDiffusion Large Language Models (dLLMs) break the rigid left-to-right constraint of traditional LLMs, enabling token generation in arbitrary orders, a flexibility that supersets the fixed autoregressive trajectory and theoretically unlocks superior reasoning. However, for general reasoning tasks (e.g., mathematics and coding), arbitrary order may in fact limit the reasoning potential of dLLMs: models exploit the flexibility to bypass high-uncertainty tokens crucial for exploration, causing a premature collapse of solution coverage. This motivates a rethink of RL approaches for dLLMs, which devote considerable complexity to preserving this flexibility. We show that effective reasoning can be elicited by simply forgoing arbitrary order and applying standard Group Relative Policy Optimization (GRPO). Our approach, JustGRPO, is minimalist yet surprisingly effective (89.1% accuracy on GSM8K) while fully retaining the parallel decoding ability of dLLMs.\n\n## 1. Introduction\n\nRecent work has seen a surge in Diffusion Large Language Models (dLLMs), which challenge the dominant autoregressive (AR) paradigm by treating sequence generation as a discrete denoising process. Central to their appeal is theoretical flexibility: efficient parallel decoding and arbitrary-order generation. Driven by successes on sudoku and zebra puzzles, the community has increasingly adopted reinforcement learning (RL) to elicit similar capabilities for general reasoning tasks such as mathematics and coding.\n\nWe present a counter-intuitive observation: for these tasks, arbitrary-order generation may narrow rather than expand the reasoning potential elicitable by RL. Using Pass@k as a proxy for solution coverage, we find that restricting a dLLM to standard AR order tends to yield a higher Pass@k than its flexible counterpart. The effect traces to how orders handle uncertainty. Reasoning hinges on sparse forking tokens, typically connectives like \"Therefore\" or \"Since\", which steer the logical trajectory into distinct branches. Arbitrary order lets the model bypass these hard decisions and resolve easier tokens first; when it returns to infill the bypassed forks, the established future context has already resolved their ambiguity, a phenomenon we term entropy degradation.\n\n## 2. Related Work\n\nWe situate our study within masked diffusion language models (LLaDA, Dream), analyses of order arbitrariness, and RL methods for dLLMs that rely on mean-field or ELBO-based surrogates over the combinatorial trajectory space.\n\n## 3. The Flexibility Trap\n\nArbitrary order is competitive at k = 1 but shows flatter Pass@k scaling on GSM8K, MATH-500, HumanEval, and MBPP; at Pass@1024 on HumanEval, 21.3% of problems are solved only by AR order versus 0.6% by arbitrary order alone, and entropy at logical forks drops sharply under arbitrary order.\n\n## 4. JustGRPO and Experiments\n\nJustGRPO defines a surrogate AR policy on the dLLM backbone, reading the next-token distribution from the logits at position k given the observed prefix and a fully masked future, making the sequence likelihood exactly computable for standard GRPO (equations summarized in text). On LLaDA-Instruct it reaches 89.1% on GSM8K, 45.1% on MATH-500, 49.4% on HumanEval, and 52.4% on MBPP (length 256), while remaining fully compatible with parallel decoding (MBPP advantage widens to +25.5% near five tokens per step).\n\n## Limitations\n\nExact likelihoods require a separate forward pass per position, an overhead JustGRPO-Fast cuts by evaluating ratios only at the top-25% highest-entropy positions; our conclusions target math and coding reasoning and may not extend to tasks where non-sequential generation genuinely helps.";
    const paper: LoopPaper = {
      id: "lp_demo5", title: "The Flexibility Trap: Rethinking the Value of Arbitrary Order in Diffusion Language Models", abstract: "Arbitrary-order generation lets dLLMs dodge high-uncertainty forking tokens, collapsing solution coverage; training left-to-right with standard GRPO (JustGRPO) reaches 89.1% on GSM8K.",
      status: "in_discussion", currentCycle: 1, cycles: [], createdAt: "2026-07-12T11:00:00Z",
    };
    const c1 = buildCycle(paper.id, 1, { kind: "text", text: ms }, [
    ["Reviewer 1", 6, "The paper challenges the presumed advantage of arbitrary-order generation in dLLMs, showing confidence-based decoding skips high-entropy branching tokens and depresses Pass@k, then trains the model as an AR policy with standard GRPO. A fresh angle on rollout sampling for group-based policy-gradient RL, with strong results against prior dLLM RL methods.", [["major" as CommentSeverity, "Experiments", "No purely random arbitrary-order baseline is compared. Random order can still land on hard branching tokens without the confidence heuristic's easy-first bias; if it matched AR, fully left-to-right generation would be unnecessary and the directionality claim would weaken."], ["major" as CommentSeverity, "Method", "JustGRPO rollouts decode one token per step without KV cache, while baselines like SPG unmask multiple tokens per step, so sampling compute is unmatched in Table 1. A learning-efficiency comparison at equal wall-clock budget against SPG is needed to rule out compute as the source of the gap."]]],
    ["Reviewer 2", 6, "Identifies the flexibility trap in dLLM RL, namely intractable likelihoods and entropy degradation, and responds with JustGRPO, which imposes a strict causal ordering for rollouts and exact likelihood computation. The position is novel and clearly argued, but underspecified experimental details make it hard to judge whether baseline comparisons are fully fair.", [["major" as CommentSeverity, "Experiments", "The paper does not state whether full fine-tuning or LoRA is used, nor the number of decoding steps at evaluation; Table 1 baselines appear quoted from prior work that typically used LoRA and 128 steps. Baselines should be re-run under a matched protocol and a reproducible codebase released."], ["question" as CommentSeverity, "Method", "Unlike vanilla dLLM GRPO where the likelihood is evaluated in one pass, JustGRPO seems to require a separate forward pass per position of each causal-like sequence. Is this correct, and is the resulting overhead structural to any-order models rather than removable?"]]],
    ["Reviewer 3", 7, "A technically sound and well-written study arguing that classical left-to-right ordering beats arbitrary order for eliciting reasoning in dLLMs, backed by Pass@k analyses on LLaDA and Dream and state-of-the-art results on four benchmarks. The simplicity-first message is compelling for a community building elaborate order-preserving RL machinery.", [["major" as CommentSeverity, "Method", "Moving from adaptive arbitrary order to strict AR changes two things at once: exact rather than approximate likelihoods, and left-to-right directionality. A fixed random-order baseline decoded one token at a time would keep the exact-likelihood advantage while isolating whether directionality itself drives the gains."], ["minor" as CommentSeverity, "Writing", "Related work appears late in the paper; placing it after the introduction would aid comprehension. The entropy-degradation argument could also be grounded in classical information-theoretic treatments of ordering, e.g., Varshney and Goyal (2006) on source coding for sets."]]],
  ]);
    paper.cycles = [c1];
    loopPapers.push(paper);
  }
})();

const pdfBlobsByPaper = new Map<string, Record<number, Blob>>();

let hydration: Promise<void> | null = null;
function ensureHydrated(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      const stored = await loadStoredPapers();
      let maxSeq = 0;
      for (const { paper, pdfBlobs } of stored) {
        if (paper.id.startsWith(DEMO_ID_PREFIX)) continue;
        if (!Array.isArray((paper as LoopPaper).cycles)) continue; // v1-shape records
        if (loopPapers.some((x) => x.id === paper.id)) continue;
        for (const c of paper.cycles) {
          if (c.manuscript.kind === "pdf") {
            const blob = pdfBlobs?.[c.cycle];
            if (blob) c.manuscript.url = URL.createObjectURL(blob);
          }
        }
        pdfBlobsByPaper.set(paper.id, pdfBlobs ?? {});
        loopPapers.push(paper);
        const n = Number(paper.id.replace("lp_", ""));
        if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
      }
      seq = Math.max(seq, maxSeq + 1);
      loopPapers.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    })();
  }
  return hydration;
}

function persist(p: LoopPaper) {
  if (p.id.startsWith(DEMO_ID_PREFIX)) return;
  void persistPaper(p, pdfBlobsByPaper.get(p.id) ?? {});
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`API ${res.status} ${path}`);
  return (await res.json()) as T;
}

const jsonPost = (path: string, body?: unknown) =>
  http<LoopPaper>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

async function mockPaper(id: string): Promise<LoopPaper> {
  await ensureHydrated();
  const p = loopPapers.find((x) => x.id === id);
  if (!p) throw new Error(`paper ${id} not found`);
  return p;
}

/** Mock agent jobs: stage narration events, then run the mock op — so the
 *  no-backend mode streams the same way the live pipeline does. */
const mockJobs = new Map<string, AgentJob>();
let jobSeq = 1;
function runMockJob(op: AgentOp, staged: string[], fn: () => Promise<LoopPaper>): { jobId: string } {
  const job: AgentJob = { id: `mjob_${jobSeq++}`, op, status: "running", events: [], paperId: null };
  mockJobs.set(job.id, job);
  void (async () => {
    try {
      for (const text of staged) {
        job.events.push({ t: now(), kind: "step", text });
        await delay(450);
      }
      const p = await fn();
      job.paperId = p.id;
      job.status = "done";
    } catch (e) {
      job.status = "error";
      job.error = String(e);
    }
  })();
  return { jobId: job.id };
}

const REVIEW_STAGES = [
  "Submission received — assigning three reviewers…",
  "Reviewer 1 is reading the manuscript (novelty focus)…",
  "Reviewer 2 is reading the manuscript (experimental rigor focus)…",
  "Reviewer 3 is reading the manuscript (clarity focus)…",
  "All three reviews are in — the discussion phase is open.",
];

const current = (p: LoopPaper) => p.cycles[p.cycles.length - 1];

export const loopApi = {
  usingMock: !BASE,

  async list(): Promise<LoopPaper[]> {
    if (BASE) return http("/api/loop/papers");
    await ensureHydrated();
    await delay(150);
    return [...loopPapers];
  },

  async get(id: string): Promise<LoopPaper> {
    if (BASE) return http(`/api/loop/papers/${id}`);
    const p = await mockPaper(id);
    await delay(120);
    return structuredClone(p);
  },

  /** Submit → cycle 1 reviews come back. No score until the meta-review. */
  async submit(input: SubmitLoopPaperInput): Promise<LoopPaper> {
    if (!input.title.trim() || (!input.text?.trim() && !input.file)) {
      throw new Error("A title and a manuscript (text or PDF) are required.");
    }
    if (BASE) {
      const form = new FormData();
      form.set("title", input.title);
      if (input.file) form.set("file", input.file);
      if (input.text) form.set("text", input.text);
      return http("/api/loop/papers", { method: "POST", body: form });
    }
    await ensureHydrated();
    await delay(1200);
    const id = `lp_${seq++}`;
    const p: LoopPaper = {
      id,
      title: input.title,
      abstract: (input.text ?? "").trim().slice(0, 280),
      status: "in_discussion",
      currentCycle: 1,
      cycles: [buildCycle(id, 1, manuscriptForSubmission(input))],
      createdAt: now(),
    };
    if (input.file) pdfBlobsByPaper.set(id, { 1: input.file });
    loopPapers.unshift(p);
    persist(p);
    return structuredClone(p);
  },

  /** Author rebuttal message; the addressed reviewer(s) respond. */
  async reply(id: string, input: { text: string; replyTo?: string }): Promise<LoopPaper> {
    if (BASE) return jsonPost(`/api/loop/papers/${id}/reply`, input);
    const p = await mockPaper(id);
    if (p.status === "decided") throw new Error("cycle already decided — resubmit to continue");
    await delay(900);
    const cyc = current(p);
    const authorMsg = pushMsg(cyc, "author", "Author", input.text, input.replyTo);
    if (cyc.draftManuscript) authorMsg.attachment = "revised-draft";
    const target = cyc.comments.find((c) => c.id === input.replyTo);
    const responders = target
      ? cyc.reviews.filter((r) => r.reviewer === target.reviewer)
      : cyc.reviews.slice(0, 2);
    for (const r of responders) {
      pushMsg(
        cyc,
        "reviewer",
        r.reviewer,
        `Thank you for the response. The clarification on ${target?.section ?? "the raised points"} addresses part of my concern; I still encourage the revision to make this explicit in the manuscript itself, and I will weigh the discussion in my final justification.`,
        authorMsg.id,
      );
    }
    persist(p);
    return structuredClone(p);
  },

  /** AI drafts revision hunks tied to review comments. */
  async revisionDraft(id: string): Promise<LoopPaper> {
    if (BASE) return jsonPost(`/api/loop/papers/${id}/revision-draft`);
    const p = await mockPaper(id);
    if (p.status === "decided") throw new Error("cycle already decided — resubmit to continue");
    await delay(1200);
    const cyc = current(p);
    cyc.pendingRevision = { hunks: mockHunks(cyc), createdAt: now() };
    persist(p);
    return structuredClone(p);
  },

  /** Apply per-hunk decisions; the allow/deny log auto-posts as rebuttal text. */
  async revisionApply(id: string, decisions: Record<string, boolean>): Promise<LoopPaper> {
    if (BASE) return jsonPost(`/api/loop/papers/${id}/revision-apply`, { decisions });
    const p = await mockPaper(id);
    const cyc = current(p);
    if (!cyc.pendingRevision) throw new Error("no pending revision draft");
    await delay(500);
    let text = cyc.manuscript.text ?? "";
    const applied: RevisionHunk[] = [];
    const declined: RevisionHunk[] = [];
    for (const h of cyc.pendingRevision.hunks) {
      h.decision = decisions[h.id] ? "allowed" : "denied";
      if (h.decision === "allowed" && text.includes(h.before)) {
        text = text.replace(h.before, h.after);
        applied.push(h);
      } else {
        declined.push(h);
      }
    }
    cyc.draftManuscript = text;
    const parts: string[] = [];
    if (applied.length) parts.push(`We revised the manuscript as follows: ${applied.map((h, i) => `(${i + 1}) ${h.rationale}`).join(" ")}`);
    if (declined.length) parts.push(`We considered but did not adopt: ${declined.map((h, i) => `(${i + 1}) ${h.rationale}`).join(" ")}`);
    // Pre-fills the composer instead of posting a ghost message.
    cyc.revisionNote = parts.join(" ") || "We reviewed the proposed revision and made no changes.";
    persist(p);
    return structuredClone(p);
  },

  /** End the cycle: AC meta-review + score + decision (like the real venue). */
  async finalize(id: string): Promise<LoopPaper> {
    if (BASE) return jsonPost(`/api/loop/papers/${id}/finalize`);
    const p = await mockPaper(id);
    if (p.status === "decided") return structuredClone(p);
    await delay(1500);
    mockFinalize(current(p));
    p.status = "decided";
    persist(p);
    return structuredClone(p);
  },

  /** Start the next cycle FRESH on the revised manuscript. */
  async resubmit(id: string): Promise<LoopPaper> {
    if (BASE) return jsonPost(`/api/loop/papers/${id}/resubmit`);
    const p = await mockPaper(id);
    if (p.status !== "decided") throw new Error("finalize the current cycle before resubmitting");
    await delay(1200);
    const prev = current(p);
    const manuscript: LoopManuscript = { ...prev.manuscript, text: prev.draftManuscript ?? prev.manuscript.text };
    p.cycles.push(buildCycle(p.id, prev.cycle + 1, manuscript));
    p.currentCycle = prev.cycle + 1;
    p.status = "in_discussion";
    const blobs = pdfBlobsByPaper.get(p.id);
    if (blobs?.[prev.cycle]) blobs[prev.cycle + 1] = blobs[prev.cycle];
    persist(p);
    return structuredClone(p);
  },

  /** Kick off a long agent op as a job; poll `job()` for streamed progress. */
  async startSubmit(input: SubmitLoopPaperInput): Promise<{ jobId: string }> {
    if (BASE) {
      const form = new FormData();
      form.set("title", input.title);
      if (input.file) form.set("file", input.file);
      if (input.text) form.set("text", input.text);
      return http("/api/loop/papers?mode=async", { method: "POST", body: form });
    }
    return runMockJob("submit", REVIEW_STAGES, () => loopApi.submit(input));
  },

  async startOp(
    id: string,
    op: Exclude<AgentOp, "submit">,
    payload?: { text?: string; replyTo?: string },
  ): Promise<{ jobId: string }> {
    if (BASE) return http(`/api/loop/papers/${id}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, payload: payload ?? {} }),
    });
    const staged: Record<string, string[]> = {
      reply: ["Delivering your message to the reviewers…", "Reviewers are reading your rebuttal…"],
      "revision-draft": [
        "Revision agent is studying the open comments and the discussion…",
        "Drafting grounded changes (no fabricated results)…",
        "Anchoring each change to the manuscript…",
      ],
      finalize: [
        "Area Chair is synthesizing the reviews and the discussion…",
        "Meta-review drafted — calibrating the selection score…",
        "Explanation head is extracting feature attributions…",
      ],
      resubmit: REVIEW_STAGES,
    };
    return runMockJob(op, staged[op], () => {
      if (op === "reply") return loopApi.reply(id, { text: payload?.text ?? "", replyTo: payload?.replyTo });
      if (op === "revision-draft") return loopApi.revisionDraft(id);
      if (op === "finalize") return loopApi.finalize(id);
      return loopApi.resubmit(id);
    });
  },

  async job(jobId: string): Promise<AgentJob> {
    if (BASE) return http(`/api/loop/jobs/${jobId}`);
    const j = mockJobs.get(jobId);
    if (!j) throw new Error(`job ${jobId} not found`);
    return { ...j, events: [...j.events] };
  },

  /** The author edits the manuscript directly — the draft rides as a chip
   *  until the next message delivers it to the reviewers. */
  async editManuscript(id: string, text: string, note?: string): Promise<LoopPaper> {
    if (BASE) return jsonPost(`/api/loop/papers/${id}/manuscript`, { text, note });
    const p = await mockPaper(id);
    if (p.status === "decided") throw new Error("cycle already decided — resubmit to continue");
    current(p).draftManuscript = text;
    persist(p);
    return structuredClone(p);
  },

  /** Discard the pending revised draft (the chip's ✕). */
  async discardDraft(id: string): Promise<LoopPaper> {
    if (BASE) return http(`/api/loop/papers/${id}/draft`, { method: "DELETE" });
    const p = await mockPaper(id);
    const cyc = current(p);
    delete cyc.draftManuscript;
    delete cyc.revisionNote;
    persist(p);
    return structuredClone(p);
  },

  /** Permanently delete a submission and all its cycles. */
  async remove(id: string): Promise<void> {
    if (BASE) {
      await http(`/api/loop/papers/${id}`, { method: "DELETE" });
      return;
    }
    await ensureHydrated();
    await delay(150);
    const idx = loopPapers.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const [removed] = loopPapers.splice(idx, 1);
    for (const c of removed.cycles) {
      if (c.manuscript.kind === "pdf" && c.manuscript.url) URL.revokeObjectURL(c.manuscript.url);
    }
    pdfBlobsByPaper.delete(id);
    if (id.startsWith(DEMO_ID_PREFIX)) hideDemoSeed(id);
    else await deleteStoredPaper(id);
  },
};
