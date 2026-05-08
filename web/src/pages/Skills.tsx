import { useMemo, useState } from 'preact/hooks';
import { BookOpen, Search, X, ExternalLink, FileText, Calendar, Tag } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Modal } from '@/components/Modal';
import { useFetch } from '@/lib/useFetch';
import { apiGet } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string | null;
  lastUpdated: number;
  hasContent: boolean;
}

interface SkillDetail extends SkillSummary {
  body: string;
  aliases: string[];
}

// Color accents per category. Kept tight so a future category is a
// one-line add. Pulled into the chip dot + skill-card top border.
const CATEGORY_COLORS: Record<string, string> = {
  'QA & Testing':       '#ef4444',
  'Engineering':        '#22c55e',
  'Browser Automation': '#a855f7',
  'Marketing & Funnels':'#f472b6',
  'Design & Visual':    '#f59e0b',
  'Content':            '#60a5fa',
  'EvoFit':             '#06b6d4',
  'Operations':         '#fb7185',
  'Integrations':       '#8b5cf6',
  'Website':            '#10b981',
  'General':            '#6b7280',
};
function colorFor(cat: string): string { return CATEGORY_COLORS[cat] || '#6b7280'; }

export function Skills() {
  const fetched = useFetch<{ root: string; skills: SkillSummary[] }>('/api/skills', 0);
  const skills = fetched.data?.skills ?? [];

  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);   // first click = preview modal
  const [detailId, setDetailId] = useState<string | null>(null);     // second click = full SKILL.md
  const [showEmpty, setShowEmpty] = useState(false);                 // include directories without SKILL.md

  // Counts for the chip row come from the unfiltered list so chip
  // numbers don't mutate when one is selected. Active filter / search
  // is applied at render time below.
  const counts = useMemo(() => {
    const map: Record<string, number> = { all: 0 };
    for (const s of skills) {
      if (!showEmpty && !s.hasContent) continue;
      map.all = (map.all || 0) + 1;
      map[s.category] = (map[s.category] || 0) + 1;
    }
    return map;
  }, [skills, showEmpty]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = skills.filter((s) => {
      if (!showEmpty && !s.hasContent) return false;
      if (activeCategory && s.category !== activeCategory) return false;
      if (q) {
        const hay = (s.id + ' ' + s.name + ' ' + s.description).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const byCat: Record<string, SkillSummary[]> = {};
    for (const s of filtered) (byCat[s.category] ??= []).push(s);
    // Stable category order: known categories first (in CATEGORY_COLORS
    // declaration order), then anything else alphabetically.
    const known = Object.keys(CATEGORY_COLORS);
    const seen = new Set<string>();
    const order: string[] = [];
    for (const cat of known) if (byCat[cat]) { order.push(cat); seen.add(cat); }
    for (const cat of Object.keys(byCat).sort()) if (!seen.has(cat)) order.push(cat);
    return { order, byCat, total: filtered.length };
  }, [skills, query, activeCategory, showEmpty]);

  const categoryIds = useMemo(() => Object.keys(counts).filter((k) => k !== 'all'), [counts]);

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Skills"
        actions={
          <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">
            {grouped.total} of {counts.all || 0} skills
          </span>
        }
      />

      {fetched.error && <PageState error={fetched.error} />}
      {fetched.loading && !fetched.data && <PageState loading />}

      {fetched.data && (
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div class="px-6 pt-4 pb-3 sticky top-0 bg-[var(--color-bg)] z-10 border-b border-[var(--color-border)]">
            <div class="flex items-center gap-2 mb-3">
              <div class="relative flex-1 max-w-md">
                <Search size={13} class="absolute left-2.5 top-2 text-[var(--color-text-faint)]" />
                <input
                  type="text"
                  value={query}
                  onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                  placeholder="Search skills…"
                  class="w-full bg-[var(--color-card)] border border-[var(--color-border)] rounded pl-7 pr-2.5 py-1.5 text-[12.5px] outline-none focus:border-[var(--color-accent)]"
                />
                {query && (
                  <button type="button" onClick={() => setQuery('')} class="absolute right-1.5 top-1.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)] p-0.5">
                    <X size={12} />
                  </button>
                )}
              </div>
              <label class="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] cursor-pointer ml-auto">
                <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty((e.target as HTMLInputElement).checked)} />
                Show bundle-only entries
              </label>
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <CategoryChip label="All" count={counts.all || 0} active={activeCategory === null} dot={null} onClick={() => setActiveCategory(null)} />
              {categoryIds.map((cat) => (
                <CategoryChip key={cat} label={cat} count={counts[cat] || 0} active={activeCategory === cat} dot={colorFor(cat)} onClick={() => setActiveCategory(cat)} />
              ))}
            </div>
          </div>

          <div class="p-6 space-y-7">
            {grouped.order.length === 0 && (
              <div class="text-[12px] text-[var(--color-text-faint)] text-center py-12">
                No skills match this filter.
              </div>
            )}
            {grouped.order.map((cat) => (
              <section key={cat}>
                <div class="flex items-center gap-2 mb-2.5">
                  <span class="w-2 h-2 rounded-full" style={{ background: colorFor(cat) }} />
                  <h2 class="text-[13px] font-semibold text-[var(--color-text)]">{cat}</h2>
                  <span class="text-[10.5px] text-[var(--color-text-faint)] tabular-nums">{grouped.byCat[cat].length}</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                  {grouped.byCat[cat].map((skill) => (
                    <SkillCard key={skill.id} skill={skill} onPreview={() => setPreviewId(skill.id)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      <SkillPreviewModal
        skillId={previewId}
        onClose={() => setPreviewId(null)}
        onOpenDetail={() => { if (previewId) { setDetailId(previewId); setPreviewId(null); } }}
      />
      <SkillDetailModal
        skillId={detailId}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}

function CategoryChip({ label, count, active, dot, onClick }: {
  label: string; count: number; active: boolean; dot: string | null; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={[
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] border transition-colors',
        active
          ? 'border-[var(--color-accent)] text-[var(--color-text)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)]',
      ].join(' ')}
    >
      {dot && <span class="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />}
      <span>{label}</span>
      <span class="text-[var(--color-text-faint)] tabular-nums">{count}</span>
    </button>
  );
}

function SkillCard({ skill, onPreview }: { skill: SkillSummary; onPreview: () => void }) {
  const accent = colorFor(skill.category);
  return (
    <button
      type="button"
      onClick={onPreview}
      title={skill.id}
      class="text-left bg-[var(--color-card)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-lg p-3 transition-colors flex flex-col gap-1.5 group"
      style={{ borderTopWidth: '2px', borderTopColor: accent }}
    >
      <div class="flex items-start gap-2">
        <BookOpen size={13} class="mt-0.5 flex-shrink-0" style={{ color: accent }} />
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-medium text-[var(--color-text)] leading-snug truncate">{skill.name}</div>
          <div class="text-[10.5px] text-[var(--color-text-faint)] font-mono truncate">{skill.id}</div>
        </div>
      </div>
      <div class="text-[11.5px] text-[var(--color-text-muted)] leading-relaxed line-clamp-2">
        {skill.description || (skill.hasContent ? '(no description in frontmatter)' : '(bundle — no SKILL.md)')}
      </div>
      <div class="flex items-center gap-2 text-[10px] text-[var(--color-text-faint)] mt-auto pt-1.5 border-t border-[var(--color-border)]">
        <Calendar size={10} />
        <span class="tabular-nums">{skill.lastUpdated > 0 ? formatRelativeTime(Math.floor(skill.lastUpdated / 1000)) : '—'}</span>
        {skill.version && (<><span>·</span><span class="font-mono">v{skill.version}</span></>)}
      </div>
    </button>
  );
}

function SkillPreviewModal({ skillId, onClose, onOpenDetail }: {
  skillId: string | null; onClose: () => void; onOpenDetail: () => void;
}) {
  const fetched = useFetch<{ skill: SkillDetail }>(skillId ? `/api/skills/${encodeURIComponent(skillId)}` : null, 0);
  const skill = fetched.data?.skill;
  const accent = skill ? colorFor(skill.category) : '#6b7280';

  return (
    <Modal
      open={skillId !== null}
      onClose={onClose}
      title={skill?.name || 'Skill'}
      width={560}
      footer={
        <>
          <button type="button" onClick={onClose} class="px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Close</button>
          <button
            type="button"
            onClick={onOpenDetail}
            disabled={!skill?.hasContent}
            class="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileText size={12} /> View instruction set
          </button>
        </>
      }
    >
      {fetched.loading && <div class="text-[12px] text-[var(--color-text-muted)]">Loading…</div>}
      {fetched.error && <div class="text-[12px] text-[var(--color-status-failed)]">Failed to load: {fetched.error}</div>}
      {skill && (
        <div class="space-y-3">
          <div class="flex items-center gap-2 text-[11px]">
            <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ background: accent + '22', color: accent }}>
              <Tag size={9} /> {skill.category}
            </span>
            {skill.version && <span class="font-mono text-[var(--color-text-faint)]">v{skill.version}</span>}
            <span class="text-[var(--color-text-faint)]">·</span>
            <span class="text-[var(--color-text-faint)] tabular-nums">{skill.lastUpdated > 0 ? formatRelativeTime(Math.floor(skill.lastUpdated / 1000)) : '—'}</span>
            <span class="ml-auto font-mono text-[10px] text-[var(--color-text-faint)]">{skill.id}</span>
          </div>

          <div class="text-[12.5px] text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">
            {skill.description || '(no description provided in this skill\'s frontmatter)'}
          </div>

          {skill.aliases.length > 0 && (
            <div class="text-[11px] text-[var(--color-text-muted)]">
              <span class="text-[var(--color-text-faint)] uppercase tracking-wider mr-1.5">Aliases:</span>
              {skill.aliases.join(', ')}
            </div>
          )}

          {!skill.hasContent && (
            <div class="text-[11.5px] text-[var(--color-text-muted)] bg-[var(--color-elevated)] border border-[var(--color-border)] rounded px-2.5 py-2">
              This entry is a bundle directory without a SKILL.md file. The detail view is not available.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function SkillDetailModal({ skillId, onClose }: { skillId: string | null; onClose: () => void }) {
  const fetched = useFetch<{ skill: SkillDetail }>(skillId ? `/api/skills/${encodeURIComponent(skillId)}` : null, 0);
  const skill = fetched.data?.skill;
  return (
    <Modal
      open={skillId !== null}
      onClose={onClose}
      title={skill ? `${skill.name} — instruction set` : 'Skill detail'}
      width={780}
      footer={
        <button type="button" onClick={onClose} class="ml-auto px-3 py-1.5 rounded text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Close</button>
      }
    >
      {fetched.loading && <div class="text-[12px] text-[var(--color-text-muted)]">Loading instruction set…</div>}
      {fetched.error && <div class="text-[12px] text-[var(--color-status-failed)]">Failed to load: {fetched.error}</div>}
      {skill && (
        <div class="space-y-2">
          <div class="text-[11px] text-[var(--color-text-faint)] flex items-center gap-2">
            <span class="font-mono">{skill.id}</span>
            {skill.version && <><span>·</span><span class="font-mono">v{skill.version}</span></>}
            {skill.lastUpdated > 0 && <><span>·</span><span class="tabular-nums">updated {formatRelativeTime(Math.floor(skill.lastUpdated / 1000))}</span></>}
          </div>
          {skill.body
            ? (
              <pre class="text-[11.5px] text-[var(--color-text)] leading-relaxed whitespace-pre-wrap font-mono bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-3 max-h-[60vh] overflow-y-auto">{skill.body}</pre>
            )
            : (
              <div class="text-[11.5px] text-[var(--color-text-muted)]">This skill has no SKILL.md body content.</div>
            )}
        </div>
      )}
    </Modal>
  );
}
