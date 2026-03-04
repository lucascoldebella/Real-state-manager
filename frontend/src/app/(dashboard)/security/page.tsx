'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Shield, AlertTriangle, Cpu, HardDrive, Activity, Ban,
  RefreshCw, Skull, Zap, Eye, CheckCircle2, Clock, Wifi,
  Search, Terminal, Download, Copy, Check
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, BarChart, Bar, Cell
} from 'recharts';
import { Card } from '../../../components/ui/Card/Card';
import { Badge } from '../../../components/ui/Badge/Badge';
import { Button } from '../../../components/ui/Button/Button';
import styles from './page.module.css';

interface SystemMetrics {
  cpu_percent: number;
  memory_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  disk_percent: number;
  disk_used_gb: number;
  disk_total_gb: number;
  load_avg: number[];
  uptime_seconds: number;
  process_count: number;
}

interface SecurityEvent {
  id: number;
  timestamp: string;
  event_type: string;
  severity: string;
  source: string;
  source_ip: string;
  description: string;
  details: string;
  action_taken: string;
  resolved: number;
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  memory_percent: number;
  exe: string;
  user: string;
  started: string;
}

interface PortInfo {
  address: string;
  port: number;
  process: string;
  pid: number;
}

interface Summary {
  severity_counts: Record<string, number>;
  ssh_attempts_24h: number;
  active_bans: number;
  suspicious_executions: number;
  unresolved_critical: number;
  events_by_type: Record<string, number>;
  system_uptime_hours: number;
  monitor_uptime_seconds: number;
}

interface MetricsHistory {
  id: number;
  timestamp: string;
  cpu_percent: number;
  memory_percent: number;
}

const MONITOR_API = '/api/monitor';

async function monitorGet<T>(path: string): Promise<T> {
  const res = await fetch(`${MONITOR_API}${path}`);
  if (!res.ok) throw new Error(`Monitor API error: ${res.status}`);
  return res.json();
}

async function monitorPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${MONITOR_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Monitor API error: ${res.status}`);
  return res.json();
}

function copyToClipboard(text: string): boolean {
  // Fallback for non-HTTPS contexts where navigator.clipboard is unavailable
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function severityColor(severity: string): 'danger' | 'warning' | 'info' | 'success' | 'neutral' {
  switch (severity.toUpperCase()) {
    case 'CRITICAL': return 'danger';
    case 'WARNING': return 'warning';
    case 'INFO': return 'info';
    default: return 'neutral';
  }
}

function eventTypeLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function eventTypeColor(type: string): string {
  if (type.includes('trusted')) return '#10b981';
  if (type.includes('unknown') || type.includes('suspicious')) return '#ef4444';
  if (type.includes('crowdsec')) return '#8b5cf6';
  if (type.includes('failed') || type.includes('invalid')) return '#f59e0b';
  if (type.includes('auditd')) return '#06b6d4';
  if (type.includes('cpu') || type.includes('memory')) return '#ec4899';
  return '#3b82f6';
}

function getRowClass(e: SecurityEvent): string {
  if (e.severity === 'CRITICAL' && !e.resolved) return styles.criticalRow;
  if (e.event_type === 'ssh_accepted_trusted') return styles.trustedRow;
  if (e.severity === 'WARNING' && !e.event_type.includes('trusted')) return styles.warningRow;
  return '';
}

export default function SecurityPage() {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [criticalEvents, setCriticalEvents] = useState<SecurityEvent[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricsHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'overview' | 'events' | 'processes' | 'ports'>('overview');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [banIp, setBanIp] = useState('');
  const [query, setQuery] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [m, s, e, c, p, po, h] = await Promise.all([
        monitorGet<SystemMetrics>('/metrics/current'),
        monitorGet<Summary>('/summary'),
        monitorGet<SecurityEvent[]>('/events?limit=200&hours=24'),
        monitorGet<SecurityEvent[]>('/events/critical'),
        monitorGet<ProcessInfo[]>('/processes'),
        monitorGet<PortInfo[]>('/ports'),
        monitorGet<MetricsHistory[]>('/metrics?hours=2&limit=240'),
      ]);
      setMetrics(m);
      setSummary(s);
      setEvents(e);
      setCriticalEvents(c);
      setProcesses(p);
      setPorts(po);
      setMetricsHistory(h.reverse());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load monitor data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleBanIp = async () => {
    if (!banIp.trim()) return;
    setActionLoading('ban');
    try {
      await monitorPost('/actions/ban', { ip: banIp.trim(), reason: 'Manual ban from dashboard' });
      setBanIp('');
      await loadData();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleKillProcess = async (pid: number) => {
    if (!confirm(`Kill process PID ${pid}?`)) return;
    setActionLoading(`kill-${pid}`);
    try {
      await monitorPost('/actions/kill', { pid });
      await loadData();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleResolve = async (id: number) => {
    setActionLoading(`resolve-${id}`);
    try {
      await monitorPost('/actions/resolve', { id });
      await loadData();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleResolveAll = async () => {
    if (!confirm(`Resolve all ${criticalEvents.length} critical alerts?`)) return;
    setActionLoading('resolve-all');
    try {
      await Promise.all(criticalEvents.map(e => monitorPost('/actions/resolve', { id: e.id })));
      await loadData();
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const handleCopyRow = (e: SecurityEvent) => {
    const csv = [
      new Date(e.timestamp + 'Z').toLocaleString(),
      e.event_type,
      e.severity,
      e.source || '',
      e.source_ip || '',
      e.description,
      e.details || '',
      e.action_taken || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

    const ok = copyToClipboard(csv);
    if (ok) {
      setCopiedId(e.id);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const handleDownloadCsv = async () => {
    setActionLoading('csv');
    try {
      const res = await fetch(`${MONITOR_API}/events/csv?limit=10000&hours=720`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `security-events-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setActionLoading(null);
  };

  const filteredEvents = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return events;
    return events.filter(e =>
      [e.event_type, e.severity, e.description, e.source_ip, e.source].join(' ').toLowerCase().includes(q)
    );
  }, [events, query]);

  const chartData = useMemo(() => {
    return metricsHistory.map(m => ({
      time: m.timestamp ? new Date(m.timestamp + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      cpu: m.cpu_percent,
      memory: m.memory_percent,
    }));
  }, [metricsHistory]);

  const eventTypeData = useMemo(() => {
    if (!summary?.events_by_type) return [];
    return Object.entries(summary.events_by_type)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({
        name: eventTypeLabel(name),
        rawName: name,
        count,
      }));
  }, [summary]);

  if (loading) return <div className={styles.container}><div className={styles.loadingState}>Loading security data...</div></div>;

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2><Shield size={24} /> Security Monitor</h2>
          <p>Real-time system security monitoring and threat detection</p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="outline" onClick={loadData} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </Button>
        </div>
      </header>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {/* Critical Alert Banner */}
      {criticalEvents.length > 0 && (
        <div className={styles.criticalBanner}>
          <Skull size={20} />
          <span><strong>{criticalEvents.length} unresolved CRITICAL alert{criticalEvents.length > 1 ? 's' : ''}</strong> — Immediate attention required</span>
        </div>
      )}

      {/* Stats Cards */}
      {metrics && summary && (
        <div className={styles.statsGrid}>
          <Card className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: 'var(--primary-light)' }}><Cpu size={20} color="var(--primary)" /></div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{metrics.cpu_percent.toFixed(1)}%</span>
              <span className={styles.statLabel}>CPU Usage</span>
            </div>
            <div className={`${styles.statIndicator} ${metrics.cpu_percent > 80 ? styles.danger : metrics.cpu_percent > 50 ? styles.warning : styles.success}`} />
          </Card>
          <Card className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: 'var(--info-bg, #eff6ff)' }}><HardDrive size={20} color="var(--info)" /></div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{metrics.memory_percent.toFixed(1)}%</span>
              <span className={styles.statLabel}>Memory ({metrics.memory_used_mb.toFixed(0)}/{metrics.memory_total_mb.toFixed(0)} MB)</span>
            </div>
            <div className={`${styles.statIndicator} ${metrics.memory_percent > 85 ? styles.danger : metrics.memory_percent > 60 ? styles.warning : styles.success}`} />
          </Card>
          <Card className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: '#fef3c7' }}><AlertTriangle size={20} color="#f59e0b" /></div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{summary.ssh_attempts_24h}</span>
              <span className={styles.statLabel}>SSH Attempts (24h)</span>
            </div>
          </Card>
          <Card className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: '#fecaca' }}><Ban size={20} color="#ef4444" /></div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{summary.active_bans}</span>
              <span className={styles.statLabel}>Active Bans</span>
            </div>
          </Card>
          <Card className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: '#d1fae5' }}><Activity size={20} color="#10b981" /></div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{formatUptime(metrics.uptime_seconds)}</span>
              <span className={styles.statLabel}>System Uptime</span>
            </div>
          </Card>
          <Card className={styles.statCard}>
            <div className={styles.statIcon} style={{ background: '#ede9fe' }}><Zap size={20} color="#8b5cf6" /></div>
            <div className={styles.statInfo}>
              <span className={styles.statValue}>{summary.suspicious_executions}</span>
              <span className={styles.statLabel}>Suspicious Execs (24h)</span>
            </div>
          </Card>
        </div>
      )}

      {/* Tab Navigation */}
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === 'overview' ? styles.active : ''}`} onClick={() => setTab('overview')}>
          <Eye size={16} /> Overview
        </button>
        <button className={`${styles.tab} ${tab === 'events' ? styles.active : ''}`} onClick={() => setTab('events')}>
          <AlertTriangle size={16} /> Events ({events.length})
        </button>
        <button className={`${styles.tab} ${tab === 'processes' ? styles.active : ''}`} onClick={() => setTab('processes')}>
          <Terminal size={16} /> Processes
        </button>
        <button className={`${styles.tab} ${tab === 'ports' ? styles.active : ''}`} onClick={() => setTab('ports')}>
          <Wifi size={16} /> Ports ({ports.length})
        </button>
      </div>

      {/* Overview Tab */}
      {tab === 'overview' && (
        <div className={styles.overviewGrid}>
          {/* CPU/Memory Chart */}
          <Card className={styles.chartCard}>
            <h3 className={styles.cardTitle}>System Resources (Last 2h)</h3>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="4 4" stroke="var(--border-color)" />
                <XAxis dataKey="time" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Area type="monotone" dataKey="cpu" stroke="#4f46e5" fill="#4f46e580" name="CPU %" />
                <Area type="monotone" dataKey="memory" stroke="#10b981" fill="#10b98180" name="Memory %" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          {/* Events by Type Chart */}
          <Card className={styles.chartCard}>
            <h3 className={styles.cardTitle}>Events by Type (24h)</h3>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={eventTypeData} layout="vertical">
                <CartesianGrid strokeDasharray="4 4" stroke="var(--border-color)" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} width={160} />
                <Tooltip />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {eventTypeData.map((entry, i) => (
                    <Cell key={i} fill={eventTypeColor(entry.rawName)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Critical Alerts */}
          <Card className={styles.alertsCard}>
            <div className={styles.alertsTitleRow}>
              <h3 className={styles.cardTitle}><Skull size={18} /> Critical Alerts</h3>
              {criticalEvents.length > 0 && (
                <button
                  className={styles.resolveAllBtn}
                  onClick={handleResolveAll}
                  disabled={actionLoading === 'resolve-all'}
                >
                  {actionLoading === 'resolve-all' ? 'Resolving...' : `Resolve All (${criticalEvents.length})`}
                </button>
              )}
            </div>
            {criticalEvents.length === 0 ? (
              <div className={styles.emptyState}><CheckCircle2 size={32} color="var(--success)" /><p>No unresolved critical alerts</p></div>
            ) : (
              <div className={styles.alertList}>
                {criticalEvents.map(e => (
                  <div key={e.id} className={styles.alertItem}>
                    <div className={styles.alertHeader}>
                      <Badge variant="danger">CRITICAL</Badge>
                      <span className={styles.alertTime}>{new Date(e.timestamp + 'Z').toLocaleString()}</span>
                    </div>
                    <p className={styles.alertDesc}>{e.description}</p>
                    {e.source_ip && <span className={styles.alertIp}>IP: {e.source_ip}</span>}
                    <Button size="sm" variant="outline" onClick={() => handleResolve(e.id)}
                      disabled={actionLoading === `resolve-${e.id}`}>
                      {actionLoading === `resolve-${e.id}` ? 'Resolving...' : 'Resolve'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Quick Actions */}
          <Card className={styles.actionsCard}>
            <h3 className={styles.cardTitle}><Shield size={18} /> Quick Actions</h3>
            <div className={styles.actionGroup}>
              <label className={styles.actionLabel}>Ban IP Address</label>
              <div className={styles.actionRow}>
                <input
                  className={styles.actionInput}
                  placeholder="e.g. 192.168.1.100"
                  value={banIp}
                  onChange={(e) => setBanIp(e.target.value)}
                />
                <Button size="sm" variant="danger" onClick={handleBanIp}
                  disabled={actionLoading === 'ban' || !banIp.trim()}>
                  <Ban size={14} /> Ban
                </Button>
              </div>
            </div>
            <div className={styles.actionGroup}>
              <label className={styles.actionLabel}>System Info</label>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}><span>Processes</span><strong>{metrics?.process_count}</strong></div>
                <div className={styles.infoItem}><span>Load Avg</span><strong>{metrics?.load_avg.map(l => l.toFixed(2)).join(', ')}</strong></div>
                <div className={styles.infoItem}><span>Disk</span><strong>{metrics?.disk_used_gb}GB / {metrics?.disk_total_gb}GB ({metrics?.disk_percent}%)</strong></div>
                <div className={styles.infoItem}><span>Monitor Uptime</span><strong>{summary ? formatUptime(summary.monitor_uptime_seconds) : '-'}</strong></div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Events Tab */}
      {tab === 'events' && (
        <Card>
          <div className={styles.eventsHeader}>
            <div className={styles.searchContainer}>
              <Search size={16} className={styles.searchIcon} />
              <input className={styles.searchInput} placeholder="Filter events..." value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            <Button variant="outline" size="sm" onClick={handleDownloadCsv} disabled={actionLoading === 'csv'}>
              <Download size={14} /> {actionLoading === 'csv' ? 'Downloading...' : 'Export CSV'}
            </Button>
          </div>
          <div className={styles.tableWrapper}>
            <table className={styles.tableCompact}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Severity</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>IP</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map(e => (
                  <tr key={e.id} className={getRowClass(e)}>
                    <td className={styles.timeCell}>{new Date(e.timestamp + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td><Badge variant={severityColor(e.severity)}>{e.severity}</Badge></td>
                    <td><code className={styles.codeSmall}>{e.event_type}</code></td>
                    <td className={styles.descCell} title={e.description}>{e.description}</td>
                    <td>{e.source_ip ? <code className={styles.codeSmall}>{e.source_ip}</code> : '-'}</td>
                    <td className={styles.actionsCell}>
                      <button className={styles.copyBtn} onClick={() => handleCopyRow(e)} title="Copy row as CSV">
                        {copiedId === e.id ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredEvents.length === 0 && <div className={styles.emptyState}><p>No events match your filter</p></div>}
        </Card>
      )}

      {/* Processes Tab */}
      {tab === 'processes' && (
        <Card>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Name</th>
                  <th>CPU %</th>
                  <th>Mem %</th>
                  <th>User</th>
                  <th>Executable</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {processes.map(p => (
                  <tr key={p.pid} className={p.cpu_percent > 80 ? styles.criticalRow : ''}>
                    <td>{p.pid}</td>
                    <td><strong>{p.name}</strong></td>
                    <td className={p.cpu_percent > 50 ? styles.highValue : ''}>{p.cpu_percent?.toFixed(1)}%</td>
                    <td>{p.memory_percent?.toFixed(1)}%</td>
                    <td>{p.user}</td>
                    <td className={styles.descCell} title={p.exe || ''}><code className={styles.code}>{p.exe || '-'}</code></td>
                    <td>
                      <Button size="sm" variant="danger" onClick={() => handleKillProcess(p.pid)}
                        disabled={actionLoading === `kill-${p.pid}`}>
                        {actionLoading === `kill-${p.pid}` ? '...' : 'Kill'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Ports Tab */}
      {tab === 'ports' && (
        <Card>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Address</th>
                  <th>Process</th>
                  <th>PID</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ports.map((p, i) => (
                  <tr key={i}>
                    <td><strong>{p.port}</strong></td>
                    <td><code className={styles.code}>{p.address}</code></td>
                    <td>{p.process}</td>
                    <td>{p.pid || '-'}</td>
                    <td>
                      <Badge variant={p.address === '0.0.0.0' || p.address === '::' ? 'warning' : 'success'}>
                        {p.address === '0.0.0.0' || p.address === '::' ? 'PUBLIC' : 'LOCAL'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
