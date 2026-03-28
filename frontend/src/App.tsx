import { useState, useEffect, useCallback } from 'react';
import './index.css';

const API = '/api/v1';

// ─── Types ────────────────────────────────────────────────────────────────────
type JobStatus =
  | 'queued' | 'script_generating' | 'script_ready'
  | 'audio_generating' | 'audio_ready'
  | 'video_generating' | 'video_processing' | 'video_ready'
  | 'pending_approval' | 'approved' | 'rejected'
  | 'editing' | 'edited' | 'uploading'
  | 'completed' | 'failed';

interface Job {
  jobId: string;
  status: JobStatus;
  approvalMode: 'auto' | 'manual';
  autoScore?: number;
  input: { topic: string; tone: string; aspectRatio: string; avatarId: string; voiceId: string };
  videoResult?: { cdnUrl: string; thumbnailUrl?: string; durationSec: number };
  storageResult?: { driveUrl: string };
  error?: { message: string; stage: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ─── Pipeline stages ──────────────────────────────────────────────────────────
const STAGES = [
  { key: 'script',   label: 'Script',   icon: '✍️',  statuses: ['script_generating','script_ready'] },
  { key: 'audio',    label: 'Audio',    icon: '🎙️',  statuses: ['audio_generating','audio_ready'] },
  { key: 'video',    label: 'Video',    icon: '🎬',  statuses: ['video_generating','video_processing','video_ready'] },
  { key: 'approval', label: 'Approval', icon: '✅',  statuses: ['pending_approval','approved'] },
  { key: 'edit',     label: 'Edit',     icon: '✂️',  statuses: ['editing','edited'] },
  { key: 'storage',  label: 'Drive',    icon: '📁',  statuses: ['uploading','completed'] },
];

function stageState(stageIdx: number, status: JobStatus): 'done' | 'active' | 'error' | 'idle' {
  const orderMap: Record<JobStatus, number> = {
    queued:0, script_generating:1, script_ready:2, audio_generating:3, audio_ready:4,
    video_generating:5, video_processing:6, video_ready:7, pending_approval:8,
    approved:9, rejected:9, editing:10, edited:11, uploading:12, completed:13, failed:-1,
  };
  if (status === 'failed') return stageIdx === 0 ? 'error' : 'idle';
  const order = orderMap[status] ?? 0;
  const stageThreshold = [2, 4, 7, 9, 11, 13];
  const stageStart     = [0, 2, 4, 7,  9, 11];
  if (order > stageThreshold[stageIdx]) return 'done';
  if (order >= stageStart[stageIdx])    return 'active';
  return 'idle';
}

function statusBadge(s: JobStatus) {
  const map: Record<string, string> = {
    queued: 'badge-queued', completed: 'badge-completed', failed: 'badge-failed',
    pending_approval: 'badge-approval', approved: 'badge-approved', rejected: 'badge-failed',
  };
  const cls = map[s] ?? 'badge-processing';
  return <span className={`badge ${cls}`}>{s.replace(/_/g,' ')}</span>;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff/1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  return `${Math.floor(diff/3600000)}h ago`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState<{id:number; msg:string; type:'success'|'error'}[]>([]);
  const add = useCallback((msg: string, type: 'success'|'error' = 'success') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);
  return { toasts, add };
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function apiFetch(path: string, opts?: RequestInit) {
  const token = localStorage.getItem('jwt_token');
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'Request failed');
  return data;
}

// ─── Pipeline Visual ─────────────────────────────────────────────────────────
function PipelineTrack({ status }: { status: JobStatus }) {
  return (
    <div className="pipeline-track">
      {STAGES.map((stage, i) => {
        const state = stageState(i, status);
        return (
          <>
            <div className={`pipeline-step ${state}`} key={stage.key}>
              <div className="pipeline-step-dot">{state === 'done' ? '✓' : stage.icon}</div>
              <div className="pipeline-step-label">{stage.label}</div>
            </div>
            {i < STAGES.length - 1 && (
              <div className={`pipeline-connector ${stageState(i, status) === 'done' ? 'done' : ''}`} key={`c-${i}`} />
            )}
          </>
        );
      })}
    </div>
  );
}

// ─── Create Job Modal ─────────────────────────────────────────────────────────
function CreateJobModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    topic: '', tone: 'professional', avatarId: '', voiceId: '',
    aspectRatio: '16:9', approvalMode: 'auto', cta: '', brandVoice: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await apiFetch('/jobs/generate', { method: 'POST', body: JSON.stringify(form) });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally { setLoading(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="flex-between mb-4">
          <h2 className="modal-title" style={{marginBottom:0}}>🎬 Generate New Video</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div className="form-group">
            <label className="form-label">Topic / Script Prompt *</label>
            <textarea className="form-textarea" placeholder="Describe the video topic or full script prompt…" value={form.topic} onChange={set('topic')} required />
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">Tone</label>
              <select className="form-select" value={form.tone} onChange={set('tone')}>
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="motivational">Motivational</option>
                <option value="educational">Educational</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Aspect Ratio</label>
              <select className="form-select" value={form.aspectRatio} onChange={set('aspectRatio')}>
                <option value="16:9">16:9 — Landscape</option>
                <option value="9:16">9:16 — Portrait (TikTok)</option>
                <option value="1:1">1:1 — Square</option>
              </select>
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">HeyGen Avatar ID *</label>
              <input className="form-input" placeholder="e.g. Daisy-inskirt-20220818" value={form.avatarId} onChange={set('avatarId')} required />
            </div>
            <div className="form-group">
              <label className="form-label">ElevenLabs Voice ID *</label>
              <input className="form-input" placeholder="e.g. EXAVITQu4vr4xnSDxMaL" value={form.voiceId} onChange={set('voiceId')} required />
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">CTA (optional)</label>
              <input className="form-input" placeholder="e.g. Visit our website today!" value={form.cta} onChange={set('cta')} />
            </div>
            <div className="form-group">
              <label className="form-label">Approval Mode</label>
              <select className="form-select" value={form.approvalMode} onChange={set('approvalMode')}>
                <option value="auto">Auto (QA Score ≥ 0.85)</option>
                <option value="manual">Manual Review</option>
              </select>
            </div>
          </div>
          {error && <div style={{color:'var(--danger)',fontSize:13,marginBottom:16}}>⚠️ {error}</div>}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading} id="submit-generate-btn">
              {loading ? <><span className="spinner" /> Queuing…</> : '🚀 Generate Video'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Job Detail Modal ─────────────────────────────────────────────────────────
function JobDetailModal({ jobId, onClose, onUpdate }: { jobId: string; onClose: () => void; onUpdate: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch(`/jobs/${jobId}`);
      setJob(data);
    } catch {}
    setLoading(false);
  }, [jobId]);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  async function approve(action: 'approve' | 'reject') {
    setApproving(true);
    try { await apiFetch(`/jobs/${jobId}/approve`, { method: 'POST', body: JSON.stringify({ action }) }); load(); onUpdate(); }
    catch {} finally { setApproving(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{maxWidth:680}}>
        <div className="flex-between mb-4">
          <h2 className="modal-title" style={{marginBottom:0}}>Job Details</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="flex-center" style={{padding:40}}><span className="spinner" /></div>}

        {job && (
          <>
            <div className="flex-between mb-4">
              {statusBadge(job.status)}
              <span className="text-muted">{timeAgo(job.createdAt)}</span>
            </div>

            <div className="card mb-4" style={{background:'var(--bg-elevated)',padding:16}}>
              <div style={{fontSize:13,color:'var(--text-secondary)',marginBottom:4}}>Topic</div>
              <div style={{fontSize:15,fontWeight:600}}>{job.input?.topic}</div>
            </div>

            <PipelineTrack status={job.status} />

            {job.status === 'pending_approval' && (
              <div className="card mb-4" style={{border:'1px solid var(--accent)',background:'var(--accent-glow)'}}>
                <div style={{fontWeight:600,marginBottom:8}}>👀 Manual Approval Required</div>
                <div style={{fontSize:13,color:'var(--text-secondary)',marginBottom:12}}>
                  QA Score: <strong>{((job.autoScore ?? 0) * 100).toFixed(0)}%</strong>
                </div>
                {job.videoResult?.cdnUrl && (
                  <a href={job.videoResult.cdnUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{marginBottom:12}}>
                    ▶ Preview Video
                  </a>
                )}
                <div style={{display:'flex',gap:8,marginTop:8}}>
                  <button className="btn btn-success" onClick={() => approve('approve')} disabled={approving} id="approve-btn">
                    {approving ? <span className="spinner"/> : '✓ Approve'}
                  </button>
                  <button className="btn btn-danger" onClick={() => approve('reject')} disabled={approving} id="reject-btn">
                    ✕ Reject
                  </button>
                </div>
              </div>
            )}

            {job.status === 'completed' && job.storageResult && (
              <div className="card mb-4" style={{border:'1px solid var(--success)'}}>
                <div style={{fontWeight:600,marginBottom:8}}>🎉 Video Ready!</div>
                <a href={job.storageResult.driveUrl} target="_blank" rel="noreferrer" className="btn btn-success btn-sm">
                  📁 Open in Google Drive
                </a>
              </div>
            )}

            {job.status === 'failed' && job.error && (
              <div className="card" style={{border:'1px solid var(--danger)'}}>
                <div style={{fontWeight:600,color:'var(--danger)',marginBottom:4}}>❌ Pipeline Failed</div>
                <div style={{fontSize:13,color:'var(--text-secondary)'}}>Stage: {job.error.stage}</div>
                <div style={{fontSize:13,marginTop:4}}>{job.error.message}</div>
              </div>
            )}

            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginTop:16}}>
              {[
                ['Job ID', job.jobId],
                ['Mode', job.approvalMode],
                ['Tone', job.input?.tone],
                ['Aspect', job.input?.aspectRatio],
              ].map(([k,v]) => (
                <div key={k} className="card" style={{padding:12,background:'var(--bg-elevated)'}}>
                  <div style={{fontSize:11,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:'0.05em'}}>{k}</div>
                  <div style={{fontSize:13,fontWeight:500,marginTop:2}}>{v}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Pages ────────────────────────────────────────────────────────────────────
function Dashboard({ jobs }: { jobs: Job[] }) {
  const counts = {
    total: jobs.length,
    completed: jobs.filter(j => j.status === 'completed').length,
    pending: jobs.filter(j => j.status === 'pending_approval').length,
    failed: jobs.filter(j => j.status === 'failed').length,
  };
  const running = jobs.filter(j => !['completed','failed','rejected'].includes(j.status)).length;

  return (
    <>
      <div className="stats-grid">
        {[
          { label: 'Total Jobs',    value: counts.total,     sub: 'all time',       color: 'var(--accent)' },
          { label: 'Completed',     value: counts.completed, sub: 'ready in Drive', color: 'var(--success)' },
          { label: 'In Progress',   value: running,          sub: 'pipeline active',color: 'var(--warning)' },
          { label: 'Needs Review',  value: counts.pending,   sub: 'awaiting your approval',color: 'var(--info)' },
          { label: 'Failed',        value: counts.failed,    sub: 'need attention', color: 'var(--danger)' },
        ].map(s => (
          <div className="stat-card" key={s.label}>
            <div className="stat-label">{s.label}</div>
            <div className="stat-value" style={{color: s.color}}>{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      <h3 style={{fontSize:15,fontWeight:700,marginBottom:16,color:'var(--text-secondary)'}}>Recent Jobs</h3>
      <RecentJobsTable jobs={jobs.slice(0, 8)} />
    </>
  );
}

function RecentJobsTable({ jobs, onSelect }: { jobs: Job[]; onSelect?: (id:string)=>void }) {
  if (!jobs.length) return (
    <div className="card">
      <div className="empty-state">
        <div className="icon">🎬</div>
        <h3>No videos yet</h3>
        <p>Click "Generate Video" to start your first AI video pipeline</p>
      </div>
    </div>
  );
  return (
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap">
        <table>
          <thead><tr>
            <th>Topic</th><th>Status</th><th>Mode</th><th>Score</th><th>Created</th>
          </tr></thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.jobId} onClick={() => onSelect?.(j.jobId)}>
                <td style={{maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {j.input?.topic ?? '—'}
                </td>
                <td>{statusBadge(j.status)}</td>
                <td><span className="badge badge-queued">{j.approvalMode}</span></td>
                <td>{j.autoScore != null ? `${(j.autoScore*100).toFixed(0)}%` : '—'}</td>
                <td className="text-muted">{timeAgo(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function JobsPage({ jobs }: { jobs: Job[] }) {
  const [selected, setSelected] = useState<string|null>(null);
  const [filter, setFilter] = useState('all');

  const filtered = filter === 'all' ? jobs : jobs.filter(j => j.status === filter || j.status.startsWith(filter));

  return (
    <>
      {selected && <JobDetailModal jobId={selected} onClose={() => setSelected(null)} onUpdate={() => {}} />}
      <div className="flex-between mb-6">
        <div style={{display:'flex',gap:8}}>
          {['all','completed','pending_approval','failed'].map(f => (
            <button key={f} className={`btn btn-sm ${filter===f?'btn-primary':'btn-secondary'}`} onClick={() => setFilter(f)}>
              {f.replace(/_/g,' ')}
            </button>
          ))}
        </div>
        <span className="text-muted">{filtered.length} jobs</span>
      </div>
      <RecentJobsTable jobs={filtered} onSelect={setSelected} />
    </>
  );
}

function ApprovalPage({ jobs, onUpdate }: { jobs: Job[]; onUpdate: () => void }) {
  const [selected, setSelected] = useState<string|null>(null);
  const pending = jobs.filter(j => j.status === 'pending_approval');

  return (
    <>
      {selected && <JobDetailModal jobId={selected} onClose={() => setSelected(null)} onUpdate={onUpdate} />}
      {!pending.length ? (
        <div className="card">
          <div className="empty-state">
            <div className="icon">✅</div>
            <h3>All caught up!</h3>
            <p>No videos waiting for your approval right now.</p>
          </div>
        </div>
      ) : (
        <div style={{display:'grid',gap:16}}>
          {pending.map(j => (
            <div className="card" key={j.jobId} style={{border:'1px solid var(--border-active)',cursor:'pointer'}} onClick={() => setSelected(j.jobId)}>
              <div className="flex-between">
                <div>
                  <div style={{fontWeight:600,marginBottom:4}}>{j.input?.topic}</div>
                  <div className="text-muted">QA Score: {j.autoScore != null ? `${(j.autoScore*100).toFixed(0)}%` : 'N/A'} · {timeAgo(j.createdAt)}</div>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <span className="badge badge-approval">Needs Review</span>
                  <button className="btn btn-primary btn-sm">Review →</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  async function generateDevToken() {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/auth/token', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
      }
    } catch {}
    setLoading(false);
  }

  return (
    <div className="flex-center" style={{height:'100vh',flexDirection:'column',gap:24}}>
      <div style={{textAlign:'center',marginBottom:8}}>
        <div style={{fontSize:40,marginBottom:12}}>🎬</div>
        <h1 style={{fontSize:24,fontWeight:800}}>Video Automation</h1>
        <p className="text-muted" style={{marginTop:4}}>Paste your JWT token to continue</p>
      </div>
      <div className="card" style={{width:'100%',maxWidth:400}}>
        <div className="form-group">
          <label className="form-label">JWT Token</label>
          <input className="form-input" type="password" placeholder="eyJ..." value={token} onChange={e => setToken(e.target.value)} />
        </div>
        <button className="btn btn-primary" style={{width:'100%', marginBottom: 12}} id="login-btn" onClick={() => { localStorage.setItem('jwt_token', token); onLogin(token); }}>
          Enter Dashboard
        </button>
        <button className="btn btn-secondary" style={{width:'100%'}} disabled={loading} onClick={generateDevToken}>
          {loading ? '..."' : '🛠️ Generate Dev Token'}
        </button>
      </div>
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────
type Page = 'dashboard' | 'jobs' | 'approval';

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('jwt_token') ?? '');
  const [page, setPage] = useState<Page>('dashboard');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const { toasts, add: addToast } = useToast();

  const loadJobs = useCallback(async () => {
    try {
      const data = await apiFetch('/jobs');
      setJobs(data.jobs ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    if (!token) return;
    loadJobs();
    const t = setInterval(loadJobs, 10000);
    return () => clearInterval(t);
  }, [token, loadJobs]);

  if (!token) return <LoginPage onLogin={t => setToken(t)} />;

  const navItems: { key: Page; label: string; icon: string }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: '⚡' },
    { key: 'jobs',      label: 'All Jobs',  icon: '📋' },
    { key: 'approval',  label: 'Approvals', icon: '✅' },
  ];

  const pendingCount = jobs.filter(j => j.status === 'pending_approval').length;

  const pageTitle: Record<Page, [string, string]> = {
    dashboard: ['Dashboard', 'AI video pipeline overview'],
    jobs:      ['All Jobs',  `${jobs.length} total videos`],
    approval:  ['Approvals', `${pendingCount} pending review`],
  };

  return (
    <div className="layout">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon">🎬</div>
          VideoAI
        </div>

        <div className="sidebar-section-label">Main</div>
        {navItems.map(n => (
          <a key={n.key} className={`nav-item ${page === n.key ? 'active' : ''}`} onClick={() => setPage(n.key)}>
            <span>{n.icon}</span>
            {n.label}
            {n.key === 'approval' && pendingCount > 0 && (
              <span style={{marginLeft:'auto',background:'var(--accent)',color:'white',borderRadius:'999px',padding:'0 7px',fontSize:11,fontWeight:700}}>
                {pendingCount}
              </span>
            )}
          </a>
        ))}

        <div style={{flex:1}} />
        <div className="sidebar-section-label">Account</div>
        <a className="nav-item" onClick={() => { localStorage.removeItem('jwt_token'); setToken(''); }}>
          <span>🚪</span> Logout
        </a>
      </nav>

      {/* Main */}
      <div className="main">
        <div className="topbar">
          <div>
            <div className="topbar-title">{pageTitle[page][0]}</div>
            <div className="topbar-subtitle">{pageTitle[page][1]}</div>
          </div>
          <button className="btn btn-primary" id="generate-video-btn" onClick={() => setShowCreate(true)}>
            + Generate Video
          </button>
        </div>

        <div className="page">
          {page === 'dashboard' && <Dashboard jobs={jobs} />}
          {page === 'jobs'      && <JobsPage jobs={jobs} />}
          {page === 'approval'  && <ApprovalPage jobs={jobs} onUpdate={loadJobs} />}
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateJobModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { addToast('Video queued successfully! 🚀', 'success'); loadJobs(); }}
        />
      )}

      {/* Toasts */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === 'success' ? '✅' : '❌'} {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
