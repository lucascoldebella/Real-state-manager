#!/usr/bin/env python3
"""
Security Monitor Daemon
Collects CrowdSec, auditd, auth logs, CPU/mem stats.
Stores events in SQLite. Exposes HTTP API for dashboard.
"""

import os
import sys
import json
import time
import sqlite3
import hashlib
import logging
import threading
import subprocess
import re
from datetime import datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import psutil

# Configuration
DB_PATH = "/opt/security-monitor/data/monitor.db"
API_PORT = 9090
API_BIND = "127.0.0.1"
COLLECT_INTERVAL = 30  # seconds between collection cycles
MAX_EVENTS = 10000  # maximum events to keep
TRUSTED_IPS = {"170.150.241.56"}  # known legitimate IPs
CPU_ALERT_THRESHOLD = 80  # percent
MEM_ALERT_THRESHOLD = 85  # percent
LOG_FILE = "/opt/security-monitor/logs/monitor.log"

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("security-monitor")


# ============================================================
# DATABASE
# ============================================================

def init_db():
    """Initialize SQLite database with schema."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    cur = conn.cursor()

    cur.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            event_type TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'INFO',
            source TEXT,
            source_ip TEXT,
            description TEXT,
            details TEXT,
            action_taken TEXT,
            resolved INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS system_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            cpu_percent REAL,
            memory_percent REAL,
            memory_used_mb REAL,
            memory_total_mb REAL,
            disk_percent REAL,
            load_avg_1 REAL,
            load_avg_5 REAL,
            load_avg_15 REAL,
            process_count INTEGER
        );

        CREATE TABLE IF NOT EXISTS blocked_ips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip TEXT NOT NULL,
            reason TEXT,
            source TEXT,
            blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT,
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS action_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now')),
            action TEXT NOT NULL,
            target TEXT,
            performed_by TEXT DEFAULT 'system',
            result TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
        CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON system_metrics(timestamp);
        CREATE INDEX IF NOT EXISTS idx_blocked_active ON blocked_ips(active);
    """)
    conn.commit()
    conn.close()
    log.info("Database initialized at %s", DB_PATH)


def get_db():
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def store_event(event_type, severity, description, source=None, source_ip=None, details=None, action_taken=None):
    """Store a security event."""
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO events (event_type, severity, source, source_ip, description, details, action_taken) VALUES (?,?,?,?,?,?,?)",
            (event_type, severity, source, source_ip, description, details, action_taken),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        log.error("Failed to store event: %s", e)


def store_metrics(cpu, mem_pct, mem_used, mem_total, disk, load1, load5, load15, procs):
    """Store system metrics snapshot."""
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO system_metrics (cpu_percent, memory_percent, memory_used_mb, memory_total_mb, disk_percent, load_avg_1, load_avg_5, load_avg_15, process_count) VALUES (?,?,?,?,?,?,?,?,?)",
            (cpu, mem_pct, mem_used, mem_total, disk, load1, load5, load15, procs),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        log.error("Failed to store metrics: %s", e)


# ============================================================
# COLLECTORS
# ============================================================

class SystemCollector:
    """Collects CPU, memory, disk, and process metrics."""

    def __init__(self):
        self.prev_cpu_alert = False
        self.prev_mem_alert = False

    def collect(self):
        cpu = psutil.cpu_percent(interval=1)
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        load = os.getloadavg()
        procs = len(psutil.pids())

        mem_used_mb = mem.used / (1024 * 1024)
        mem_total_mb = mem.total / (1024 * 1024)

        store_metrics(cpu, mem.percent, mem_used_mb, mem_total_mb, disk.percent, load[0], load[1], load[2], procs)

        # CPU alert
        if cpu > CPU_ALERT_THRESHOLD:
            if not self.prev_cpu_alert:
                # Find top CPU processes
                top_procs = []
                for p in sorted(psutil.process_iter(["pid", "name", "cpu_percent"]), key=lambda x: x.info["cpu_percent"] or 0, reverse=True)[:5]:
                    top_procs.append(f"{p.info['name']}(pid={p.info['pid']}) {p.info['cpu_percent']:.1f}%")
                details = "; ".join(top_procs)
                store_event("cpu_spike", "WARNING", f"CPU at {cpu:.1f}% (threshold: {CPU_ALERT_THRESHOLD}%)", source="system", details=details)
                self.prev_cpu_alert = True
        else:
            self.prev_cpu_alert = False

        # Memory alert
        if mem.percent > MEM_ALERT_THRESHOLD:
            if not self.prev_mem_alert:
                store_event("memory_high", "WARNING", f"Memory at {mem.percent:.1f}% ({mem_used_mb:.0f}/{mem_total_mb:.0f} MB)", source="system")
                self.prev_mem_alert = True
        else:
            self.prev_mem_alert = False

        return {"cpu": cpu, "memory": mem.percent, "disk": disk.percent}


class SuspiciousProcessCollector:
    """Detects suspicious processes."""

    KNOWN_MINERS = {"xmrig", "kdevtmpfsi", "kinsing", "ld-linux", "dbused", "solrd", "xmr-stak", "minergate", "cpuminer"}
    SUSPICIOUS_PATHS = {"/tmp/", "/var/tmp/", "/dev/shm/", "/run/"}
    SAFE_PROCESSES = {"python3", "node", "npm", "next-server", "postgres", "postgresql",
                      "nginx", "sshd", "systemd", "crowdsec", "coldnb-server", "realstate-server",
                      "pm2", "auditd", "fail2ban", "ufw"}

    def __init__(self):
        self.seen_pids = set()

    def collect(self):
        alerts = []
        for proc in psutil.process_iter(["pid", "name", "exe", "cmdline", "cpu_percent", "create_time"]):
            try:
                info = proc.info
                pid = info["pid"]
                name = (info["name"] or "").lower()
                exe = info["exe"] or ""
                cmdline = " ".join(info["cmdline"] or [])

                # Check for known miner names
                if any(miner in name for miner in self.KNOWN_MINERS):
                    if pid not in self.seen_pids:
                        self.seen_pids.add(pid)
                        store_event(
                            "malware_detected", "CRITICAL",
                            f"Known mining malware detected: {name} (PID {pid})",
                            source="process_monitor",
                            details=f"exe={exe} cmd={cmdline[:200]}",
                        )
                        alerts.append(pid)

                # Check for execution from suspicious paths
                if exe and any(exe.startswith(p) for p in self.SUSPICIOUS_PATHS):
                    if pid not in self.seen_pids:
                        self.seen_pids.add(pid)
                        cpu = info.get("cpu_percent", 0) or 0
                        severity = "CRITICAL" if cpu > 50 else "WARNING"
                        store_event(
                            "suspicious_exec", severity,
                            f"Execution from suspicious path: {exe} (PID {pid})",
                            source="process_monitor",
                            details=f"cmd={cmdline[:200]} cpu={cpu}%",
                        )

                # Check for unknown high-CPU processes
                cpu = info.get("cpu_percent", 0) or 0
                if cpu > 80 and pid not in self.seen_pids and name not in self.SAFE_PROCESSES:
                    age = time.time() - (info.get("create_time", time.time()) or time.time())
                    if age > 60:  # sustained > 60 seconds
                        self.seen_pids.add(pid)
                        store_event(
                            "high_cpu_process", "CRITICAL",
                            f"Unknown high-CPU process: {name} (PID {pid}) at {cpu:.1f}% for {age:.0f}s",
                            source="process_monitor",
                            details=f"exe={exe} cmd={cmdline[:200]}",
                        )
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        # Cleanup old PIDs
        active_pids = set(psutil.pids())
        self.seen_pids &= active_pids

        return alerts


class AuthLogCollector:
    """Parses /var/log/auth.log for failed SSH attempts."""

    FAILED_RE = re.compile(r"Failed password for (?:invalid user )?(\S+) from (\S+) port (\d+)")
    ACCEPTED_RE = re.compile(r"Accepted (?:publickey|password) for (\S+) from (\S+) port (\d+)")
    INVALID_USER_RE = re.compile(r"Invalid user (\S+) from (\S+)")

    def __init__(self):
        self.last_pos = 0
        self.failed_counts = {}  # ip -> count in current window
        self.last_reset = time.time()

    def collect(self):
        events = []
        auth_log = "/var/log/auth.log"
        if not os.path.exists(auth_log):
            return events

        try:
            with open(auth_log, "r") as f:
                f.seek(0, 2)  # end of file
                current_size = f.tell()
                if current_size < self.last_pos:
                    self.last_pos = 0  # log rotated
                f.seek(self.last_pos)
                new_lines = f.readlines()
                self.last_pos = f.tell()
        except Exception as e:
            log.error("Failed to read auth.log: %s", e)
            return events

        # Reset counters every 10 minutes
        if time.time() - self.last_reset > 600:
            self.failed_counts.clear()
            self.last_reset = time.time()

        for line in new_lines:
            # Failed password
            m = self.FAILED_RE.search(line)
            if m:
                user, ip, port = m.groups()
                self.failed_counts[ip] = self.failed_counts.get(ip, 0) + 1
                count = self.failed_counts[ip]

                if count >= 5:
                    severity = "CRITICAL"
                elif count >= 3:
                    severity = "WARNING"
                else:
                    severity = "INFO"

                store_event(
                    "ssh_failed", severity,
                    f"Failed SSH login for '{user}' from {ip}:{port} (attempt #{count})",
                    source="auth.log", source_ip=ip,
                    details=f"user={user} attempts={count}",
                )
                events.append({"type": "ssh_failed", "ip": ip, "user": user})

            # Invalid user
            m = self.INVALID_USER_RE.search(line)
            if m:
                user, ip = m.groups()
                store_event(
                    "ssh_invalid_user", "WARNING",
                    f"SSH login attempt with invalid user '{user}' from {ip}",
                    source="auth.log", source_ip=ip,
                )

            # Accepted login
            m = self.ACCEPTED_RE.search(line)
            if m:
                user, ip, port = m.groups()
                if ip in TRUSTED_IPS:
                    event_type = "ssh_accepted_trusted"
                    severity = "INFO"
                    desc = f"Trusted SSH login for '{user}' from {ip}:{port}"
                else:
                    event_type = "ssh_accepted_unknown"
                    severity = "WARNING"
                    desc = f"Unknown SSH login for '{user}' from {ip}:{port}"
                store_event(
                    event_type, severity,
                    desc,
                    source="auth.log", source_ip=ip,
                )

        return events


class CrowdSecCollector:
    """Collects CrowdSec alerts and decisions."""

    def __init__(self):
        self.seen_ids = set()

    def collect(self):
        events = []
        try:
            result = subprocess.run(
                ["cscli", "alerts", "list", "-o", "json", "--limit", "20"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                alerts = json.loads(result.stdout)
                if isinstance(alerts, list):
                    for alert in alerts:
                        alert_id = alert.get("id", "")
                        if alert_id in self.seen_ids:
                            continue
                        self.seen_ids.add(alert_id)
                        scenario = alert.get("scenario", "unknown")
                        source_ip = alert.get("source", {}).get("ip", "")
                        source_scope = alert.get("source", {}).get("scope", "")
                        decisions = alert.get("decisions", []) or []

                        severity = "CRITICAL" if decisions else "WARNING"
                        action = ", ".join(d.get("type", "") for d in decisions) if decisions else "alert only"

                        store_event(
                            "crowdsec_alert", severity,
                            f"CrowdSec: {scenario} from {source_ip}",
                            source="crowdsec", source_ip=source_ip,
                            details=json.dumps({"scenario": scenario, "scope": source_scope, "alert_id": alert_id}),
                            action_taken=action,
                        )
                        events.append({"scenario": scenario, "ip": source_ip})
        except Exception as e:
            log.debug("CrowdSec collection: %s", e)

        # Collect active decisions (bans)
        try:
            result = subprocess.run(
                ["cscli", "decisions", "list", "-o", "json"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                decisions = json.loads(result.stdout)
                if isinstance(decisions, list):
                    conn = get_db()
                    for d in decisions:
                        ip = d.get("value", "")
                        if ip:
                            existing = conn.execute("SELECT id FROM blocked_ips WHERE ip=? AND active=1", (ip,)).fetchone()
                            if not existing:
                                conn.execute(
                                    "INSERT INTO blocked_ips (ip, reason, source, expires_at) VALUES (?,?,?,?)",
                                    (ip, d.get("scenario", ""), "crowdsec", d.get("until", "")),
                                )
                    conn.commit()
                    conn.close()
        except Exception as e:
            log.debug("CrowdSec decisions collection: %s", e)

        return events


class AuditdCollector:
    """Collects auditd events by parsing raw audit.log."""

    SAFE_EXES = {"/usr/lib/postgresql", "/usr/bin/postgres"}
    AUDIT_KEYS = {
        "tmp_exec": ("CRITICAL", "Execution from /tmp"),
        "var_tmp_exec": ("CRITICAL", "Execution from /var/tmp"),
        "shm_exec": ("CRITICAL", "Execution from /dev/shm"),
        "tmp_write": ("WARNING", "Write to /tmp"),
        "var_tmp_write": ("WARNING", "Write to /var/tmp"),
        "shm_write": ("WARNING", "Write to /dev/shm"),
        "crontab_mod": ("WARNING", "Crontab modified"),
        "cron_spool": ("WARNING", "Cron spool modified"),
        "cron_d": ("WARNING", "Cron.d modified"),
        "passwd_changes": ("CRITICAL", "Password file modified"),
        "shadow_changes": ("CRITICAL", "Shadow file modified"),
        "sshd_config": ("WARNING", "SSHD config changed"),
        "sshd_config_d": ("WARNING", "SSHD config.d changed"),
        "systemd_services": ("WARNING", "Systemd service changed"),
        "systemd_lib_services": ("WARNING", "Systemd lib service changed"),
    }

    def __init__(self):
        self.last_ts = time.time()

    def collect(self):
        events = []
        try:
            check_since = self.last_ts
            self.last_ts = time.time()

            try:
                with open("/var/log/audit/audit.log", "r") as f:
                    lines = f.readlines()
            except Exception:
                return events

            for line in lines:
                if "type=SYSCALL" not in line:
                    continue
                km = re.search(r'key="([^"]+)"', line)
                if not km:
                    continue
                key = km.group(1)
                if key not in self.AUDIT_KEYS or key == "(null)":
                    continue

                tm = re.search(r'audit\((\d+\.\d+):', line)
                if not tm:
                    continue
                event_ts = float(tm.group(1))
                if event_ts <= check_since:
                    continue

                if any(safe in line for safe in self.SAFE_EXES):
                    continue

                severity, desc = self.AUDIT_KEYS[key]
                exe_m = re.search(r'exe="([^"]+)"', line)
                exe = exe_m.group(1) if exe_m else "unknown"
                comm_m = re.search(r'comm="([^"]+)"', line)
                comm = comm_m.group(1) if comm_m else "unknown"

                store_event(
                    "auditd_" + key, severity,
                    f"Auditd: {desc} - {comm} ({exe})",
                    source="auditd",
                    details=line.strip()[:500],
                )
                events.append({"key": key})

        except Exception as e:
            log.debug("Auditd collection: %s", e)

        return events


class PortCollector:
    """Monitors listening ports for unexpected changes."""

    def __init__(self):
        self.known_ports = set()
        self.first_run = True

    def collect(self):
        events = []
        current_ports = set()
        try:
            for conn in psutil.net_connections(kind="inet"):
                if conn.status == "LISTEN":
                    port = conn.laddr.port
                    addr = conn.laddr.ip
                    current_ports.add((addr, port))

            if self.first_run:
                self.known_ports = current_ports
                self.first_run = False
                return events

            new_ports = current_ports - self.known_ports
            for addr, port in new_ports:
                # Find the process
                proc_name = "unknown"
                for conn in psutil.net_connections(kind="inet"):
                    if conn.status == "LISTEN" and conn.laddr.port == port:
                        try:
                            proc_name = psutil.Process(conn.pid).name() if conn.pid else "unknown"
                        except psutil.NoSuchProcess:
                            pass
                        break

                severity = "CRITICAL" if addr in ("0.0.0.0", "::") else "WARNING"
                store_event(
                    "new_listener", severity,
                    f"New listening port: {addr}:{port} ({proc_name})",
                    source="port_monitor",
                    details=f"process={proc_name} addr={addr} port={port}",
                )
                events.append({"port": port, "process": proc_name})

            self.known_ports = current_ports
        except Exception as e:
            log.debug("Port collection: %s", e)

        return events


# ============================================================
# API SERVER
# ============================================================

class MonitorAPIHandler(BaseHTTPRequestHandler):
    """HTTP API handler for the security dashboard."""

    def log_message(self, format, *args):
        pass  # Suppress default HTTP logging

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(json.dumps(data, default=str).encode())

    def _send_error(self, status, message):
        self._send_json({"error": message}, status)

    def do_OPTIONS(self):
        self._send_json({})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        try:
            if path == "/api/monitor/health":
                self._handle_health()
            elif path == "/api/monitor/metrics":
                self._handle_metrics(params)
            elif path == "/api/monitor/metrics/current":
                self._handle_current_metrics()
            elif path == "/api/monitor/events":
                self._handle_events(params)
            elif path == "/api/monitor/events/critical":
                self._handle_critical_events()
            elif path == "/api/monitor/blocked":
                self._handle_blocked_ips()
            elif path == "/api/monitor/processes":
                self._handle_processes()
            elif path == "/api/monitor/ports":
                self._handle_ports()
            elif path == "/api/monitor/summary":
                self._handle_summary()
            elif path == "/api/monitor/actions":
                self._handle_action_log()
            elif path == "/api/monitor/events/csv":
                self._handle_events_csv(params)
            else:
                self._send_error(404, "not_found")
        except Exception as e:
            log.error("API error: %s", e)
            self._send_error(500, str(e))

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len).decode() if content_len else "{}"

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._send_error(400, "invalid_json")
            return

        try:
            if path == "/api/monitor/actions/ban":
                self._handle_ban_ip(data)
            elif path == "/api/monitor/actions/kill":
                self._handle_kill_process(data)
            elif path == "/api/monitor/actions/resolve":
                self._handle_resolve_event(data)
            elif path == "/api/monitor/actions/unban":
                self._handle_unban_ip(data)
            else:
                self._send_error(404, "not_found")
        except Exception as e:
            log.error("API action error: %s", e)
            self._send_error(500, str(e))

    # --- GET handlers ---

    def _handle_health(self):
        self._send_json({
            "status": "healthy",
            "uptime": time.time() - START_TIME,
            "version": "1.0.0",
            "collectors": ["system", "processes", "auth_log", "crowdsec", "auditd", "ports"],
        })

    def _handle_current_metrics(self):
        cpu = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage("/")
        load = os.getloadavg()
        uptime = time.time() - psutil.boot_time()

        self._send_json({
            "cpu_percent": cpu,
            "memory_percent": mem.percent,
            "memory_used_mb": round(mem.used / (1024 * 1024), 1),
            "memory_total_mb": round(mem.total / (1024 * 1024), 1),
            "disk_percent": disk.percent,
            "disk_used_gb": round(disk.used / (1024**3), 1),
            "disk_total_gb": round(disk.total / (1024**3), 1),
            "load_avg": list(load),
            "uptime_seconds": uptime,
            "process_count": len(psutil.pids()),
        })

    def _handle_metrics(self, params):
        hours = int(params.get("hours", ["1"])[0])
        limit = int(params.get("limit", ["120"])[0])
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM system_metrics WHERE timestamp > datetime('now', ?) ORDER BY timestamp DESC LIMIT ?",
            (f"-{hours} hours", limit),
        ).fetchall()
        conn.close()
        self._send_json([dict(r) for r in rows])

    def _handle_events(self, params):
        severity = params.get("severity", [None])[0]
        event_type = params.get("type", [None])[0]
        limit = int(params.get("limit", ["50"])[0])
        hours = int(params.get("hours", ["24"])[0])

        conn = get_db()
        query = "SELECT * FROM events WHERE timestamp > datetime('now', ?)"
        args = [f"-{hours} hours"]

        if severity:
            query += " AND severity = ?"
            args.append(severity)
        if event_type:
            query += " AND event_type = ?"
            args.append(event_type)

        query += " ORDER BY timestamp DESC LIMIT ?"
        args.append(limit)

        rows = conn.execute(query, args).fetchall()
        conn.close()
        self._send_json([dict(r) for r in rows])

    def _handle_critical_events(self):
        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM events WHERE severity='CRITICAL' AND resolved=0 ORDER BY timestamp DESC LIMIT 20"
        ).fetchall()
        conn.close()
        self._send_json([dict(r) for r in rows])

    def _handle_blocked_ips(self):
        conn = get_db()
        rows = conn.execute("SELECT * FROM blocked_ips WHERE active=1 ORDER BY blocked_at DESC").fetchall()
        conn.close()
        self._send_json([dict(r) for r in rows])

    def _handle_processes(self):
        procs = []
        for p in sorted(psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "exe", "username", "create_time"]),
                        key=lambda x: x.info.get("cpu_percent") or 0, reverse=True)[:30]:
            try:
                info = p.info
                procs.append({
                    "pid": info["pid"],
                    "name": info["name"],
                    "cpu_percent": info.get("cpu_percent", 0),
                    "memory_percent": round(info.get("memory_percent", 0) or 0, 1),
                    "exe": info.get("exe", ""),
                    "user": info.get("username", ""),
                    "started": datetime.fromtimestamp(info.get("create_time", 0)).isoformat() if info.get("create_time") else "",
                })
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        self._send_json(procs)

    def _handle_ports(self):
        ports = []
        seen = set()
        for conn in psutil.net_connections(kind="inet"):
            if conn.status == "LISTEN":
                key = (conn.laddr.ip, conn.laddr.port)
                if key in seen:
                    continue
                seen.add(key)
                proc_name = "unknown"
                try:
                    if conn.pid:
                        proc_name = psutil.Process(conn.pid).name()
                except psutil.NoSuchProcess:
                    pass
                ports.append({
                    "address": conn.laddr.ip,
                    "port": conn.laddr.port,
                    "process": proc_name,
                    "pid": conn.pid,
                })
        self._send_json(sorted(ports, key=lambda x: x["port"]))

    def _handle_summary(self):
        conn = get_db()
        now_minus_24h = "-24 hours"

        # Count events by severity in last 24h
        severity_counts = {}
        for row in conn.execute(
            "SELECT severity, COUNT(*) as cnt FROM events WHERE timestamp > datetime('now', ?) GROUP BY severity",
            (now_minus_24h,),
        ).fetchall():
            severity_counts[row["severity"]] = row["cnt"]

        # SSH attempts
        ssh_attempts = conn.execute(
            "SELECT COUNT(*) as cnt FROM events WHERE event_type IN ('ssh_failed','ssh_invalid_user') AND timestamp > datetime('now', ?)",
            (now_minus_24h,),
        ).fetchone()["cnt"]

        # Active bans
        active_bans = conn.execute("SELECT COUNT(*) as cnt FROM blocked_ips WHERE active=1").fetchone()["cnt"]

        # Suspicious executions
        suspicious_execs = conn.execute(
            "SELECT COUNT(*) as cnt FROM events WHERE event_type IN ('suspicious_exec','malware_detected','high_cpu_process') AND timestamp > datetime('now', ?)",
            (now_minus_24h,),
        ).fetchone()["cnt"]

        # Unresolved critical
        unresolved_critical = conn.execute(
            "SELECT COUNT(*) as cnt FROM events WHERE severity='CRITICAL' AND resolved=0"
        ).fetchone()["cnt"]

        # Events by type
        type_counts = {}
        for row in conn.execute(
            "SELECT event_type, COUNT(*) as cnt FROM events WHERE timestamp > datetime('now', ?) GROUP BY event_type ORDER BY cnt DESC LIMIT 10",
            (now_minus_24h,),
        ).fetchall():
            type_counts[row["event_type"]] = row["cnt"]

        # System uptime
        uptime = time.time() - psutil.boot_time()

        conn.close()

        self._send_json({
            "severity_counts": severity_counts,
            "ssh_attempts_24h": ssh_attempts,
            "active_bans": active_bans,
            "suspicious_executions": suspicious_execs,
            "unresolved_critical": unresolved_critical,
            "events_by_type": type_counts,
            "trusted_ips": list(TRUSTED_IPS),
            "system_uptime_hours": round(uptime / 3600, 1),
            "monitor_uptime_seconds": round(time.time() - START_TIME, 0),
        })

    def _handle_action_log(self):
        conn = get_db()
        rows = conn.execute("SELECT * FROM action_log ORDER BY timestamp DESC LIMIT 50").fetchall()
        conn.close()
        self._send_json([dict(r) for r in rows])


    def _send_csv(self, csv_content, filename="events.csv"):
        data = csv_content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _handle_events_csv(self, params):
        limit = int(params.get("limit", ["10000"])[0])
        hours = int(params.get("hours", ["720"])[0])  # default 30 days

        conn = get_db()
        rows = conn.execute(
            "SELECT * FROM events WHERE timestamp > datetime('now', ?) ORDER BY timestamp DESC LIMIT ?",
            (f"-{hours} hours", limit),
        ).fetchall()
        conn.close()

        import csv
        import io
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["ID", "Timestamp", "Event Type", "Severity", "Source", "Source IP", "Description", "Details", "Action Taken", "Resolved"])
        for r in rows:
            d = dict(r)
            writer.writerow([
                d.get("id", ""),
                d.get("timestamp", ""),
                d.get("event_type", ""),
                d.get("severity", ""),
                d.get("source", ""),
                d.get("source_ip", ""),
                d.get("description", ""),
                d.get("details", ""),
                d.get("action_taken", ""),
                "Yes" if d.get("resolved") else "No",
            ])
        self._send_csv(output.getvalue())

    # --- POST handlers (actions) ---

    def _handle_ban_ip(self, data):
        ip = data.get("ip", "").strip()
        reason = data.get("reason", "manual ban")
        if not ip:
            self._send_error(400, "ip_required")
            return

        try:
            result = subprocess.run(
                ["cscli", "decisions", "add", "--ip", ip, "--reason", reason, "--duration", "24h", "--type", "ban"],
                capture_output=True, text=True, timeout=10,
            )
            success = result.returncode == 0
            conn = get_db()
            conn.execute(
                "INSERT INTO blocked_ips (ip, reason, source) VALUES (?,?,?)",
                (ip, reason, "manual"),
            )
            conn.execute(
                "INSERT INTO action_log (action, target, performed_by, result) VALUES (?,?,?,?)",
                ("ban_ip", ip, "dashboard", "success" if success else f"failed: {result.stderr}"),
            )
            conn.commit()
            conn.close()
            self._send_json({"success": success, "ip": ip})
        except Exception as e:
            self._send_error(500, str(e))

    def _handle_kill_process(self, data):
        pid = data.get("pid")
        if not pid:
            self._send_error(400, "pid_required")
            return

        try:
            proc = psutil.Process(int(pid))
            name = proc.name()
            proc.kill()
            conn = get_db()
            conn.execute(
                "INSERT INTO action_log (action, target, performed_by, result) VALUES (?,?,?,?)",
                ("kill_process", f"PID {pid} ({name})", "dashboard", "success"),
            )
            conn.commit()
            conn.close()
            self._send_json({"success": True, "pid": pid, "name": name})
        except psutil.NoSuchProcess:
            self._send_error(404, "process_not_found")
        except Exception as e:
            self._send_error(500, str(e))

    def _handle_resolve_event(self, data):
        event_id = data.get("id")
        if not event_id:
            self._send_error(400, "id_required")
            return

        conn = get_db()
        conn.execute("UPDATE events SET resolved=1 WHERE id=?", (int(event_id),))
        conn.execute(
            "INSERT INTO action_log (action, target, performed_by) VALUES (?,?,?)",
            ("resolve_event", f"event #{event_id}", "dashboard"),
        )
        conn.commit()
        conn.close()
        self._send_json({"success": True, "id": event_id})

    def _handle_unban_ip(self, data):
        ip = data.get("ip", "").strip()
        if not ip:
            self._send_error(400, "ip_required")
            return

        try:
            subprocess.run(
                ["cscli", "decisions", "delete", "--ip", ip],
                capture_output=True, text=True, timeout=10,
            )
            conn = get_db()
            conn.execute("UPDATE blocked_ips SET active=0 WHERE ip=? AND active=1", (ip,))
            conn.execute(
                "INSERT INTO action_log (action, target, performed_by) VALUES (?,?,?)",
                ("unban_ip", ip, "dashboard"),
            )
            conn.commit()
            conn.close()
            self._send_json({"success": True, "ip": ip})
        except Exception as e:
            self._send_error(500, str(e))


# ============================================================
# MAIN LOOP
# ============================================================

START_TIME = time.time()


def collector_loop():
    """Main collection loop running in background thread."""
    system = SystemCollector()
    processes = SuspiciousProcessCollector()
    auth_log = AuthLogCollector()
    crowdsec = CrowdSecCollector()
    auditd = AuditdCollector()
    ports = PortCollector()

    log.info("Collector loop started (interval: %ds)", COLLECT_INTERVAL)

    while True:
        try:
            system.collect()
            processes.collect()
            auth_log.collect()
            crowdsec.collect()
            auditd.collect()
            ports.collect()
        except Exception as e:
            log.error("Collector error: %s", e)

        time.sleep(COLLECT_INTERVAL)


def cleanup_loop():
    """Periodically clean old data."""
    while True:
        try:
            conn = get_db()
            # Cap events at MAX_EVENTS
            count = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            if count > MAX_EVENTS:
                excess = count - MAX_EVENTS
                conn.execute("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id ASC LIMIT ?)", (excess,))
            # Keep 48 hours of metrics
            conn.execute("DELETE FROM system_metrics WHERE timestamp < datetime('now', '-48 hours')")
            # Keep 30 days of action log
            conn.execute("DELETE FROM action_log WHERE timestamp < datetime('now', '-30 days')")
            conn.commit()
            conn.close()
        except Exception as e:
            log.error("Cleanup error: %s", e)
        time.sleep(3600)  # Run hourly


def main():
    """Entry point."""
    log.info("Security Monitor starting...")

    # Initialize database
    init_db()

    # Store startup event
    store_event("monitor_start", "INFO", "Security Monitor daemon started", source="monitor")

    # Start collector thread
    collector_thread = threading.Thread(target=collector_loop, daemon=True)
    collector_thread.start()

    # Start cleanup thread
    cleanup_thread = threading.Thread(target=cleanup_loop, daemon=True)
    cleanup_thread.start()

    # Start API server
    log.info("API server starting on %s:%d", API_BIND, API_PORT)
    server = HTTPServer((API_BIND, API_PORT), MonitorAPIHandler)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
