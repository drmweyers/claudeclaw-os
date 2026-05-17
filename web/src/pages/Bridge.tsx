import { useState } from 'preact/hooks';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { useFetch } from '@/lib/useFetch';

interface BridgeEvent {
  schema_version: string;
  event_id: string;
  ts: string;
  source: 'hermes' | 'hal';
  source_session_id: string;
  event_type: string;
  redacted: boolean;
  redaction_audit_id: string;
  payload: Record<string, unknown>;
  links: unknown[];
}

interface BridgeResponse {
  sources: string[];
  hours: number;
  count: number;
  events: BridgeEvent[];
}

type Source = 'all' | 'hermes' | 'hal';
type WindowHours = 6 | 24 | 72 | 168;

const SOURCE_COLOR: Record<string, string> = {
  hermes: 'var(--color-accent)',
  hal: '#5eb6ff',
};

const EVENT_TYPE_COLOR: Record<string, string> = {
  session_summary: '#9ca3af',
  decision_record: '#9ca3af',
  spend_marker: '#f87171',
  private_aside: '#fbbf24',
  task_completed: '#6ee7b7',
  task_dispatched: '#60a5fa',
  content_state_change: '#a78bfa',
  heartbeat_claim: '#9ca3af',
  bridge_health: '#fbbf24',
};

function detailFor(e: BridgeEvent): string {
  const p = e.payload || {};
  if (e.event_type === 'private_aside') return '[off-record — redacted by sentinel]';
  if (e.event_type === 'spend_marker') {
    const cents = (p.cost_cents as number) ?? 0;
    const bucket = (p.bucket as string) ?? '';
    const model = (p.model as string) ?? (p.model_used as string) ?? '';
    return '$' + (cents / 100).toFixed(2) + (bucket ? ' · ' + bucket : '') + (model ? ' · ' + model : '');
  }
  if (typeof p.summary === 'string') return p.summary as string;
  return e.event_type;
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function Bridge() {
  const [source, setSource] = useState<Source>('all');
  const [hours, setHours] = useState<WindowHours>(24);
  const path = `/api/bridge/recent?source=${source}&hours=${hours}`;
  const { data, loading, error } = useFetch<BridgeResponse>(path, 30_000);
  const events = data?.events ?? [];

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        title="Bridge"
        actions={
          <>
            <span class="text-[11px] text-[var(--color-text-muted)] tabular-nums">{events.length} events</span>
            <WindowSwitcher hours={hours} onChange={setHours} />
          </>
        }
        tabs={
          <>
            <Tab label="Both" active={source === 'all'} onClick={() => setSource('all')} />
            <Tab label="From Claw" active={source === 'hermes'} onClick={() => setSource('hermes')} />
            <Tab label="From Hal" active={source === 'hal'} onClick={() => setSource('hal')} />
          </>
        }
      />

      {/* Persistent how-to strip — always visible so you don't have to remember. */}
      <div class="mx-6 mt-3 mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-4 py-3 text-[12px] leading-relaxed text-[var(--color-text)]">
        <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-accent)] mb-1.5">
          How to use the bridge
        </div>
        <div class="text-[var(--color-text-muted)]">
          <div class="mb-1">
            <span class="text-[var(--color-text)]">Ask in Telegram:</span>{' '}
            <Code>/bridge</Code> (last 24h, both sides) ·{' '}
            <Code>/bridge hal 6</Code> (Hal only, 6h) ·{' '}
            <Code>/bridge hermes 72</Code> (you only, 3d)
          </div>
          <div class="mb-1">
            <span class="text-[var(--color-text)]">Or just ask Claw conversationally:</span>{' '}
            <em>"what did Hal do overnight?"</em> — the agent runs the reader CLI on its own.
          </div>
          <div>
            <span class="text-[var(--color-text)]">Keep a turn off-record:</span>{' '}
            type <Code accent="warning">##private</Code> or{' '}
            <Code accent="warning">(off-record)</Code> or{' '}
            <Code accent="warning">(don't share)</Code> anywhere in the message. The turn collapses to{' '}
            <em>private_aside</em>; Hal sees a gap, never the content.
          </div>
        </div>
      </div>

      {error && <PageState error={error} />}
      {loading && !data && <PageState loading />}
      {!loading && !error && events.length === 0 && (
        <PageState
          empty
          emptyTitle="No bridge events in window"
          emptyDescription={`Nothing from ${source === 'all' ? 'either side' : source} in the last ${hours}h. Hit /newchat in Telegram to close a session and emit your first session_summary.`}
        />
      )}

      {events.length > 0 && (
        <div class="flex-1 overflow-y-auto">
          <table class="w-full text-[12px]">
            <thead class="sticky top-0 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
              <tr class="text-left">
                <th class="px-6 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[12%]">When</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[10%]">Source</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] w-[18%]">Type</th>
                <th class="px-3 py-2 font-medium text-[10px] uppercase tracking-wider text-[var(--color-text-faint)]">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id} class="border-b border-[var(--color-border)] hover:bg-[var(--color-elevated)] transition-colors">
                  <td class="px-6 py-2 text-[var(--color-text-faint)] tabular-nums whitespace-nowrap">
                    {whenLabel(e.ts)}
                  </td>
                  <td class="px-3 py-2">
                    <span class="inline-flex items-center gap-1.5" style={{ color: SOURCE_COLOR[e.source] || 'var(--color-text-muted)' }}>
                      <span class="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: 'currentColor' }} />
                      {e.source}
                    </span>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px]" style={{ color: EVENT_TYPE_COLOR[e.event_type] || 'var(--color-text-muted)' }}>
                    {e.event_type}
                  </td>
                  <td class="px-3 py-2 text-[var(--color-text)] truncate max-w-0">
                    {detailFor(e)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Code({ children, accent }: { children: any; accent?: 'warning' }) {
  const color = accent === 'warning' ? '#fbbf24' : 'var(--color-text)';
  return (
    <code
      class="rounded px-1.5 py-0.5 text-[11px] font-mono"
      style={{ background: 'var(--color-card)', color }}
    >
      {children}
    </code>
  );
}

function WindowSwitcher({ hours, onChange }: { hours: WindowHours; onChange: (h: WindowHours) => void }) {
  const opts: WindowHours[] = [6, 24, 72, 168];
  return (
    <div class="inline-flex bg-[var(--color-elevated)] border border-[var(--color-border)] rounded p-0.5">
      {opts.map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => onChange(h)}
          class={[
            'inline-flex items-center justify-center px-2 h-7 rounded text-[11px] font-medium transition-colors',
            hours === h
              ? 'bg-[var(--color-accent)] text-white'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
          ].join(' ')}
        >
          {h < 24 ? `${h}h` : `${h / 24}d`}
        </button>
      ))}
    </div>
  );
}
