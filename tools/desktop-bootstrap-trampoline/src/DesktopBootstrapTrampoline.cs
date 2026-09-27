using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// P5.8 Desktop bootstrap trampoline (see tools/desktop-bootstrap-trampoline and docs/p5.8-desktop-capability-activation-bootstrap.md).
//
// Launched by the Codex Desktop backend through CODEX_CLI_PATH. It captures the inherited
// CODEX_APP_TOOLS_PIPE_PATH, optionally hands that capability to the local LRM launcher, then
// transparently spawns the real bundled codex.exe with the original argv, stdio, cwd and
// environment, waits for it and forwards its exit code. It never writes to stdout or stderr.
internal static class DesktopBootstrapTrampoline
{
    private const string LogFileName = "trampoline.jsonl";
    private const string ConfigFileName = "trampoline.config.ini";
    private const string PipeEnvName = "CODEX_APP_TOOLS_PIPE_PATH";
    private const string CliEnvName = "CODEX_CLI_PATH";
    private const string OverrideEnvName = "LRM_PROBE_REAL_CODEX";
    private const string ConfigEnvName = "LRM_P58_CONFIG";
    private const string SelfCheckEnvName = "LRM_TRAMPOLINE_SELF_CHECK";
    private const string HandoffPath = "/launcher/desktop-tools-pipe";
    private const string ProbePath = "/launcher/desktop-tools-pipe/probe";

    // Low frequency on purpose: a healthy handoff is only re-checked on this cadence, and a failing
    // recovery backs off up to MaxRecoveryBackoffMs instead of hammering the launcher.
    private const int MaintenanceIntervalMs = 5000;
    private const int MaxRecoveryBackoffMs = 30000;

    // Fail-closed exit codes: the probe never guesses a real codex.exe and never runs another.
    private const int ExitResolutionFailed = 78;
    private const int ExitSpawnFailed = 79;

    private const int StdInputHandle = -10;
    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint Infinite = 0xFFFFFFFF;

    private static int Main(string[] args)
    {
        // Desktop never sets this, and it is checked before anything touches argv, stdio, the
        // launcher, or the child process, so the real launch path stays byte for byte unchanged.
        if (Environment.GetEnvironmentVariable(SelfCheckEnvName) == "1")
        {
            return SelfCheck.Run();
        }

        Config config = Config.Load();
        string logDirectory = ResolveLogDirectory(config);
        string ownPath = OwnPath();
        DateTime startedUtc = DateTime.UtcNow;
        string commandLine = Environment.CommandLine;
        string pipeValue = Environment.GetEnvironmentVariable(PipeEnvName);
        string cliValue = Environment.GetEnvironmentVariable(CliEnvName);
        Resolution resolution = ResolveRealCodex(config);

        RecordLaunch(
            delegate(string line) { Append(logDirectory, line); },
            config,
            resolution,
            ownPath,
            startedUtc,
            commandLine,
            pipeValue,
            cliValue);

        if (resolution.Path == null)
        {
            Append(logDirectory, Failure("resolution_failed", "no bundled codex.exe candidate found"));
            return ExitResolutionFailed;
        }

        if (SamePath(resolution.Path, ownPath))
        {
            Append(logDirectory, Failure("recursion_detected", "resolved real codex.exe is this probe"));
            return ExitResolutionFailed;
        }

        ManualResetEvent handoffStop = StartHandoff(
            config,
            delegate(string line) { Append(logDirectory, line); },
            pipeValue,
            startedUtc);

        string childCommandLine = Quote(resolution.Path) + ArgumentTail(commandLine);
        StringBuilder childBuffer = new StringBuilder(childCommandLine, childCommandLine.Length + 16);

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        IntPtr stdIn = GetStdHandle(StdInputHandle);
        IntPtr stdOut = GetStdHandle(StdOutputHandle);
        IntPtr stdErr = GetStdHandle(StdErrorHandle);
        if (IsValidHandle(stdIn) && IsValidHandle(stdOut) && IsValidHandle(stdErr))
        {
            // Hand the exact inherited handles to the child so the JSON-RPC pipes stay identical.
            startup.dwFlags = StartfUseStdHandles;
            startup.hStdInput = stdIn;
            startup.hStdOutput = stdOut;
            startup.hStdError = stdErr;
        }

        PROCESS_INFORMATION process;
        bool spawned = CreateProcessW(
            null, childBuffer, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out process);
        if (!spawned)
        {
            StopHandoff(handoffStop);
            Append(logDirectory, Failure(
                "spawn_failed",
                "CreateProcessW failed with win32 error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture)));
            return ExitSpawnFailed;
        }

        Append(logDirectory, new JsonObject()
            .Add("event", "spawned")
            .Add("ts_utc", Iso(DateTime.UtcNow))
            .Add("probe_pid", CurrentProcessId())
            .Add("child_pid", process.dwProcessId)
            .Add("child_command_line", childCommandLine)
            .ToString());

        WaitForSingleObject(process.hProcess, Infinite);
        StopHandoff(handoffStop);
        uint exitCode;
        bool hasExitCode = GetExitCodeProcess(process.hProcess, out exitCode);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);

        Append(logDirectory, new JsonObject()
            .Add("event", "exit")
            .Add("ts_utc", Iso(DateTime.UtcNow))
            .Add("probe_pid", CurrentProcessId())
            .Add("child_pid", process.dwProcessId)
            .Add("child_exit_code", hasExitCode ? unchecked((int)exitCode) : -1)
            .Add("duration_ms", (int)(DateTime.UtcNow - startedUtc).TotalMilliseconds)
            .ToString());

        return hasExitCode ? unchecked((int)exitCode) : 1;
    }

    private static string Failure(string eventName, string reason)
    {
        return new JsonObject()
            .Add("event", eventName)
            .Add("ts_utc", Iso(DateTime.UtcNow))
            .Add("probe_pid", CurrentProcessId())
            .Add("reason", reason)
            .ToString();
    }

    // Only the presence of the Desktop pipe environment is recorded: the path itself is capability
    // material and is never written to a log, a config file, or any LRM state.
    private static void RecordLaunch(
        Action<string> log,
        Config config,
        Resolution resolution,
        string ownPath,
        DateTime startedUtc,
        string commandLine,
        string pipeValue,
        string cliValue)
    {
        log(new JsonObject()
            .Add("event", "launch")
            .Add("ts_utc", Iso(startedUtc))
            .Add("ts_local", Iso(DateTime.Now))
            .Add("probe_pid", CurrentProcessId())
            .Add("parent_pid", ParentProcessId())
            .Add("probe_path", ownPath)
            .Add("command_line", commandLine)
            .AddArray("argv", Environment.GetCommandLineArgs())
            .Add("cwd", SafeCurrentDirectory())
            .Add("pipe_env_name", PipeEnvName)
            .Add("pipe_present", !string.IsNullOrEmpty(pipeValue))
            .Add("codex_cli_path", cliValue)
            .Add("codex_cli_path_equals_probe", cliValue != null && SamePath(cliValue, ownPath))
            .Add("config_path", config.ConfigPath)
            .Add("handoff_enabled", config.HandoffEnabled && !string.IsNullOrEmpty(pipeValue))
            .Add("handoff_base_url", config.BaseUrl)
            .Add("handoff_deadline_seconds", config.HandoffDeadlineSeconds)
            .Add("real_codex_path", resolution.Path)
            .Add("real_codex_source", resolution.Source)
            .Add("real_codex_length", resolution.Length)
            .Add("real_codex_last_write_utc", resolution.LastWriteUtc)
            .AddArray("candidate_paths", resolution.Candidates)
            .ToString());
    }

    // Experiment configuration. The token is read from this local file only: it is never logged,
    // never placed in argv, and never sent anywhere except the configured loopback launcher.
    private sealed class Config
    {
        public string ConfigPath;
        public string LogDir;
        public string RealCodexPath;
        public bool HandoffEnabled = true;
        public string BaseUrl;
        public string AuthToken;
        public int HandoffDeadlineSeconds = 120;
        public int HandoffTimeoutSeconds = 2;

        public static Config Load()
        {
            Config config = new Config();
            string path = Environment.GetEnvironmentVariable(ConfigEnvName);
            if (string.IsNullOrEmpty(path))
            {
                path = Path.Combine(ToolDirectory(), ConfigFileName);
            }

            config.ConfigPath = path;
            if (!File.Exists(path))
            {
                return config;
            }

            foreach (string rawLine in File.ReadAllLines(path))
            {
                string line = rawLine.Trim();
                if (line.Length == 0 || line[0] == '#' || line[0] == ';')
                {
                    continue;
                }

                int separator = line.IndexOf('=');
                if (separator <= 0)
                {
                    continue;
                }

                string key = line.Substring(0, separator).Trim().ToLowerInvariant();
                string value = line.Substring(separator + 1).Trim();
                if (key == "logdir") config.LogDir = value;
                else if (key == "realcodexpath") config.RealCodexPath = value;
                else if (key == "handoffenabled") config.HandoffEnabled = value.Equals("true", StringComparison.OrdinalIgnoreCase);
                else if (key == "baseurl") config.BaseUrl = value;
                else if (key == "authtoken") config.AuthToken = value;
                else if (key == "handoffdeadlineseconds") config.HandoffDeadlineSeconds = Seconds(value, config.HandoffDeadlineSeconds);
                else if (key == "handofftimeoutseconds") config.HandoffTimeoutSeconds = Seconds(value, config.HandoffTimeoutSeconds);
            }

            return config;
        }

        private static int Seconds(string value, int fallback)
        {
            int parsed;
            return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed > 0
                ? parsed
                : fallback;
        }
    }

    internal sealed class HandoffRequest
    {
        public string Url;
        public string Token;
        public int TimeoutMs;
        public string Body;
    }

    internal sealed class HandoffResponse
    {
        public int Status;
        public string Body;
    }

    /// A single launcher answer, reduced to the only four states the supervisor reacts to.
    internal enum HandoffOutcome
    {
        /// 200 accepted=true: LRM holds the capability against the current Desktop owner.
        Accepted,

        /// 202 pending=true: loopback evidence registered, waiting for the existing owner promotion.
        Pending,

        /// 409/503/unreachable: LRM cannot bind yet, so back off and offer the same pipe again.
        Retry,

        /// 400/401/403: deterministic configuration or authentication failure, fail closed.
        Rejected
    }

    internal enum ProbeOutcome
    {
        /// 200 connected=true: LRM still holds a usable handoff, so nothing needs to be re-posted.
        Healthy,

        /// 409/503/unreachable: the handoff is gone or LRM is down, so re-offer the pipe.
        Unhealthy,

        /// 400/401/403: deterministic failure, fail closed instead of retrying forever.
        Rejected
    }

    ///
    /// Owns the whole handoff lifecycle for one Codex Desktop lifetime: a bounded cold-start
    /// bootstrap, then low frequency maintenance that re-offers the same inherited pipe whenever
    /// the probe stops proving the capability. It never stores the pipe anywhere but the request
    /// it builds, and it never decides capability: LRM's existing owner binding still does.
    /// </summary>
    internal sealed class HandoffSupervisor
    {
        private readonly string endpoint;
        private readonly string token;
        private readonly string pipePath;
        private readonly int timeoutMs;
        private readonly Func<HandoffRequest, HandoffResponse> send;
        private readonly Action<string> log;
        private readonly Func<int, bool> sleep;
        private readonly int[] recoveryBackoffMs;
        private bool maintenance;
        private int failureIndex;
        private int attempts;
        private int handoffPosts;
        private int probeChecks;
        private string lastProbeState;

        public HandoffSupervisor(
            string endpoint,
            string token,
            string pipePath,
            int timeoutMs,
            Func<HandoffRequest, HandoffResponse> send,
            Action<string> log,
            Func<int, bool> sleep,
            int[] recoveryBackoffMs)
        {
            this.endpoint = endpoint;
            this.token = token;
            this.pipePath = pipePath;
            this.timeoutMs = timeoutMs;
            this.send = send;
            this.log = log;
            this.sleep = sleep;
            this.recoveryBackoffMs = recoveryBackoffMs;
        }

        public int HandoffPosts { get { return handoffPosts; } }

        public int ProbeChecks { get { return probeChecks; } }

        /// One interval step. Returns false when the supervisor is finished: a deterministic
        /// rejection, or the stop signal reporting that the real codex.exe has exited.
        public bool Step(DateTime startedUtc, int deadlineSeconds)
        {
            if (!maintenance)
            {
                return Bootstrap(startedUtc, deadlineSeconds);
            }

            return Maintain(startedUtc);
        }

        ///
        /// A positive cycle budget runs exactly that many steps and returns, which is how the tests
        /// observe the loop without timers. A non-positive budget runs until the stop signal fires.
        /// </summary>
        public void Run(DateTime startedUtc, int deadlineSeconds, int cycleBudget)
        {
            for (int cycle = 0; cycleBudget <= 0 || cycle < cycleBudget; cycle++)
            {
                if (!Step(startedUtc, deadlineSeconds))
                {
                    return;
                }
            }
        }

        // First handoff: bounded retries until LRM accepts or the cold-start deadline expires.
        // Expiry is not terminal. Maintenance then keeps watching for as long as Codex runs, so a
        // Desktop IPC reconnect or an MCP runtime restart is still recovered without a restart.
        private bool Bootstrap(DateTime startedUtc, int deadlineSeconds)
        {
            int[] delays = new int[] { 0, 1000, 2000, 3000, 5000, 8000, 13000, 21000, 34000, 55000 };
            for (int index = 0; index < delays.Length; index++)
            {
                if (ElapsedSeconds(startedUtc) > deadlineSeconds)
                {
                    break;
                }

                if (delays[index] > 0 && !sleep(delays[index]))
                {
                    return false;
                }

                HandoffOutcome outcome = PostHandoff();
                Record("bootstrap", outcome, startedUtc);
                if (outcome != HandoffOutcome.Retry)
                {
                    if (outcome == HandoffOutcome.Accepted || outcome == HandoffOutcome.Pending)
                    {
                        EnterMaintenance();
                    }

                    return outcome != HandoffOutcome.Rejected && sleep(MaintenanceIntervalMs);
                }
            }

            EnterMaintenance();
            log(new JsonObject()
                .Add("event", "handoff_giving_up")
                .Add("ts_utc", Iso(DateTime.UtcNow))
                .Add("probe_pid", CurrentProcessId())
                .Add("attempts", attempts)
                .Add("elapsed_ms", (int)(DateTime.UtcNow - startedUtc).TotalMilliseconds)
                .ToString());
            return sleep(MaintenanceIntervalMs);
        }

        // One probe decides whether the existing handoff still stands. Any other answer re-offers
        // the pipe path this process inherited at launch, which is still the same Desktop pipe.
        private bool Maintain(DateTime startedUtc)
        {
            probeChecks++;
            ProbeOutcome probe = Probe();
            RecordProbeState(probe);
            if (probe == ProbeOutcome.Rejected)
            {
                return false;
            }

            if (probe == ProbeOutcome.Healthy)
            {
                failureIndex = 0;
                return sleep(MaintenanceIntervalMs);
            }

            // The cold-start deadline deliberately does not apply here. It bounds the first burst of
            // retries, not the Desktop lifetime: an MCP runtime restart minutes later must still be
            // recovered, because the Desktop owning this pipe never went away.
            HandoffOutcome outcome = PostHandoff();
            Record("maintenance", outcome, startedUtc);
            if (outcome == HandoffOutcome.Rejected)
            {
                return false;
            }

            if (outcome != HandoffOutcome.Retry)
            {
                failureIndex = 0;
                return sleep(MaintenanceIntervalMs);
            }

            return sleep(BackoffMs());
        }

        // Only a state change is written, so a healthy Desktop does not grow an event per cycle
        // while a real recovery is still visible in the log.
        private void RecordProbeState(ProbeOutcome probe)
        {
            string current = probe.ToString();
            if (lastProbeState == current)
            {
                return;
            }

            lastProbeState = current;
            log(new JsonObject()
                .Add("event", "maintenance_probe")
                .Add("ts_utc", Iso(DateTime.UtcNow))
                .Add("probe_pid", CurrentProcessId())
                .Add("probe_state", current)
                .Add("probe_checks", probeChecks)
                .ToString());
        }

        private void EnterMaintenance()
        {
            maintenance = true;
            failureIndex = 0;
        }

        private HandoffOutcome PostHandoff()
        {
            attempts++;
            handoffPosts++;
            return ClassifyHandoff(send(new HandoffRequest
            {
                Url = endpoint + HandoffPath,
                Token = token,
                TimeoutMs = timeoutMs,
                Body = "{\"pipePath\":" + JString(pipePath) + "}",
            }));
        }

        private ProbeOutcome Probe()
        {
            return ClassifyProbe(send(new HandoffRequest
            {
                Url = endpoint + ProbePath,
                Token = token,
                TimeoutMs = timeoutMs,
                Body = string.Empty,
            }));
        }

        internal static HandoffOutcome ClassifyHandoff(HandoffResponse response)
        {
            if (response.Status == 200 && Contains(response.Body, "\"accepted\":true"))
            {
                return HandoffOutcome.Accepted;
            }

            if (response.Status == 202 && Contains(response.Body, "\"pending\":true"))
            {
                return HandoffOutcome.Pending;
            }

            return IsDeterministic(response.Status) ? HandoffOutcome.Rejected : HandoffOutcome.Retry;
        }

        // 200 connected=true is the only proof that LRM still holds a usable Desktop tools pipe.
        // A pipeSource other than handoff is a weaker source, so it is not treated as healthy.
        internal static ProbeOutcome ClassifyProbe(HandoffResponse response)
        {
            if (response.Status == 200
                && Contains(response.Body, "\"connected\":true")
                && Contains(response.Body, "\"pipeSource\":\"handoff\""))
            {
                return ProbeOutcome.Healthy;
            }

            return IsDeterministic(response.Status) ? ProbeOutcome.Rejected : ProbeOutcome.Unhealthy;
        }

        // 400/401/403 cannot become an acceptance by repeating, so the trampoline fails closed.
        private static bool IsDeterministic(int status)
        {
            return status == 400 || status == 401 || status == 403;
        }

        private static bool Contains(string body, string needle)
        {
            return body != null && body.Contains(needle);
        }

        private int BackoffMs()
        {
            int index = failureIndex < recoveryBackoffMs.Length ? failureIndex : recoveryBackoffMs.Length - 1;
            failureIndex++;
            int value = recoveryBackoffMs[index];
            return value > MaxRecoveryBackoffMs ? MaxRecoveryBackoffMs : value;
        }

        private static double ElapsedSeconds(DateTime startedUtc)
        {
            return (DateTime.UtcNow - startedUtc).TotalSeconds;
        }

        // The pipe path never appears here: only the phase, the attempt count, and the elapsed time.
        private void Record(string phase, HandoffOutcome outcome, DateTime startedUtc)
        {
            log(new JsonObject()
                .Add("event", EventName(phase, outcome))
                .Add("ts_utc", Iso(DateTime.UtcNow))
                .Add("probe_pid", CurrentProcessId())
                .Add("phase", phase)
                .Add("attempt", attempts)
                .Add("elapsed_ms", (int)(DateTime.UtcNow - startedUtc).TotalMilliseconds)
                .ToString());
        }

        private static string EventName(string phase, HandoffOutcome outcome)
        {
            if (outcome == HandoffOutcome.Accepted) return "handoff_accepted";
            if (outcome == HandoffOutcome.Pending) return "handoff_pending";
            if (outcome == HandoffOutcome.Rejected) return "handoff_rejected";
            return phase == "bootstrap" ? "handoff_retry" : "handoff_recover";
        }
    }

    private sealed class HandoffJob
    {
        public HandoffSupervisor Supervisor;
        public int DeadlineSeconds;
        public DateTime StartedUtc;

        // Signalled when the real codex.exe exits, so maintenance can never hold the process open.
        public readonly ManualResetEvent StopSignal = new ManualResetEvent(false);

        public bool Sleep(int milliseconds)
        {
            return !StopSignal.WaitOne(milliseconds);
        }
    }

    // Runs on a background thread so the real codex.exe is never delayed by the handoff. The
    // bounded retries cover the window where LRM has not reconnected to Desktop IPC yet, and the
    // same worker then keeps the capability alive for the whole Codex child lifetime.
    private static ManualResetEvent StartHandoff(
        Config config,
        Action<string> log,
        string pipeValue,
        DateTime startedUtc)
    {
        if (!config.HandoffEnabled
            || string.IsNullOrEmpty(pipeValue)
            || string.IsNullOrEmpty(config.BaseUrl)
            || string.IsNullOrEmpty(config.AuthToken))
        {
            return null;
        }

        HandoffJob job = new HandoffJob();
        job.StartedUtc = startedUtc;
        job.DeadlineSeconds = config.HandoffDeadlineSeconds;
        job.Supervisor = new HandoffSupervisor(
            config.BaseUrl,
            config.AuthToken,
            pipeValue,
            config.HandoffTimeoutSeconds * 1000,
            Send,
            log,
            job.Sleep,
            new int[] { 5000, 10000, 20000, 30000 });
        Thread worker = new Thread(HandoffWorker);
        worker.IsBackground = true;
        worker.Start(job);
        return job.StopSignal;
    }

    private static void HandoffWorker(object state)
    {
        HandoffJob job = (HandoffJob)state;
        job.Supervisor.Run(job.StartedUtc, job.DeadlineSeconds, 0);
    }

    ///
    /// Assert-based self-check for the handoff lifecycle. It drives the real HandoffSupervisor with
    /// a scripted launcher and a fake clock, so every recovery rule is verified without a timer, a
    /// live LRM, or a real Desktop. Run it with LRM_TRAMPOLINE_SELF_CHECK=1; the exit code is the
    /// only output, so it can be asserted from any test runner.
    /// </summary>
    internal static class SelfCheck
    {
        private const string Pipe = "\\\\.\\pipe\\codex-app-tools";
        private static readonly int[] Backoff = new int[] { 5000, 10000, 20000, 30000 };

        private sealed class Scenario
        {
            public readonly List<string> Calls = new List<string>();
            public readonly List<string> Bodies = new List<string>();
            public readonly List<int> Sleeps = new List<int>();
            public readonly List<string> Logs = new List<string>();
            public Queue<HandoffResponse> Replies = new Queue<HandoffResponse>();
            public HandoffResponse HandoffFallback = Response(409, "{\"error\":\"desktop_tools_pipe_unavailable\"}");
            public HandoffResponse ProbeFallback = Response(200, "{\"connected\":true,\"pipeSource\":\"handoff\"}");
        }

        public static int Run()
        {
            try
            {
                AcceptedStartsMaintenance();
                HealthyProbeDoesNotRepost();
                UnreachableRuntimeReposts();
                UnavailableProbeReposts();
                PendingKeepsWaitingForHealth();
                DeterministicFailureStopsRetrying();
                RecoveryOutlivesTheColdStartDeadline();
                BackoffIsBounded();
                PipePathIsNeverLogged();
                Classification();
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
        }

        // A healthy handoff costs exactly one POST no matter how many cycles run.
        private static void AcceptedStartsMaintenance()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 5);
            Assert(supervisor.HandoffPosts == 1, "expected one handoff POST, got " + supervisor.HandoffPosts);
            Assert(supervisor.ProbeChecks == 4, "expected four probe checks, got " + supervisor.ProbeChecks);
            Assert(scenario.Calls.Count == 5, "a healthy handoff must not re-POST");
            Assert(scenario.Calls[0].EndsWith("/launcher/desktop-tools-pipe", StringComparison.Ordinal),
                "first call must be the handoff POST");
            for (int index = 1; index < scenario.Calls.Count; index++)
            {
                Assert(scenario.Calls[index].EndsWith("/probe", StringComparison.Ordinal),
                    "maintenance must probe, not re-POST");
            }
        }

        private static void HealthyProbeDoesNotRepost()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeHealthy());
            scenario.Replies.Enqueue(ProbeHealthy());
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 2);
            Assert(supervisor.HandoffPosts == 1, "probe health must not trigger another handoff");
            Assert(supervisor.ProbeChecks == 1,
                "expected one probe, got " + supervisor.ProbeChecks + " calls=" + string.Join(",", scenario.Calls.ToArray()));
        }

        // MCP runtime is down: the probe cannot even be answered, so the pipe is re-offered.
        private static void UnreachableRuntimeReposts()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(Unreachable());
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeHealthy());
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 3);
            Assert(supervisor.HandoffPosts == 2,
                "an unreachable runtime must re-offer the pipe, got " + supervisor.HandoffPosts
                    + " calls=" + string.Join(",", scenario.Calls.ToArray()));
            Assert(supervisor.ProbeChecks == 2,
                "each maintenance cycle probes once, got " + supervisor.ProbeChecks);
        }

        // The runtime is back but the handoff is gone: 409 unavailable still means re-POST.
        private static void UnavailableProbeReposts()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(Probe(409, "{\"connected\":false,\"error\":\"desktop_tools_pipe_unavailable\"}"));
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeHealthy());
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 2);
            Assert(supervisor.HandoffPosts == 2, "a 409 probe must re-offer the pipe");
            Assert(supervisor.ProbeChecks == 1, "expected one probe before the re-POST");
        }

        // 202 pending is not health: keep probing and re-posting until LRM reports a real handoff.
        private static void PendingKeepsWaitingForHealth()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Pending());
            scenario.Replies.Enqueue(ProbeUnhealthy());
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeHealthy());
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 3);
            Assert(supervisor.HandoffPosts == 2, "pending must keep the handoff being re-offered");
            Assert(supervisor.ProbeChecks == 2, "pending must be followed by another probe");
        }

        // 400/401/403 are deterministic, so the supervisor gives up instead of spinning forever.
        private static void DeterministicFailureStopsRetrying()
        {
            foreach (int status in new int[] { 400, 401, 403 })
            {
                Scenario scenario = Healthy();
                scenario.Replies.Enqueue(Response(status, "{\"error\":\"desktop_tools_pipe_invalid\"}"));
                HandoffSupervisor supervisor = Supervisor(scenario);
                supervisor.Run(DateTime.UtcNow, 120, 5);
                Assert(supervisor.HandoffPosts == 1, "a deterministic failure must not be retried");
                Assert(supervisor.ProbeChecks == 0, "a rejected bootstrap must not start maintenance");
            }

            Scenario probeFailure = Healthy();
            probeFailure.Replies.Enqueue(Accepted());
            probeFailure.Replies.Enqueue(Response(401, "{}"));
            HandoffSupervisor rejectingProbe = Supervisor(probeFailure);
            rejectingProbe.Run(DateTime.UtcNow, 120, 5);
            Assert(rejectingProbe.HandoffPosts == 1, "a 401 probe must not re-POST forever");
            Assert(rejectingProbe.ProbeChecks == 1, "a rejected probe must end maintenance");
        }

        // The cold-start deadline bounds the first retry burst only. A restart that happens long
        // after it must still recover, or a long-lived Desktop session could never heal.
        private static void RecoveryOutlivesTheColdStartDeadline()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeUnhealthy());
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeHealthy());
            HandoffSupervisor supervisor = Supervisor(scenario);
            // The first step accepts the handoff, so the supervisor is already in maintenance; the
            // start time is then far in the past, which is a Desktop session that has been running
            // for hours before the MCP runtime restarted.
            supervisor.Step(DateTime.UtcNow, 120);
            supervisor.Run(DateTime.UtcNow.AddHours(-6), 120, 2);
            Assert(supervisor.HandoffPosts == 2,
                "recovery must not stop at the cold-start deadline, got " + supervisor.HandoffPosts);
            Assert(supervisor.ProbeChecks == 2, "expected both maintenance probes to run");
        }

        private static void BackoffIsBounded()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            scenario.ProbeFallback = ProbeUnhealthy();
            scenario.HandoffFallback = Response(503, "{}");
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 5);
            Assert(supervisor.HandoffPosts == 5,
                "every unhealthy cycle re-offers the pipe, got " + supervisor.HandoffPosts);
            for (int index = 0; index < scenario.Sleeps.Count; index++)
            {
                Assert(scenario.Sleeps[index] <= 30000, "sleep exceeded the maintenance ceiling");
            }

            Assert(scenario.Sleeps.Contains(30000), "recovery backoff must reach the ceiling and stop");
        }

        // The pipe path may appear in a launcher request body and nowhere else.
        private static void PipePathIsNeverLogged()
        {
            Scenario scenario = Healthy();
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeUnhealthy());
            scenario.Replies.Enqueue(Accepted());
            scenario.Replies.Enqueue(ProbeHealthy());
            HandoffSupervisor supervisor = Supervisor(scenario);
            supervisor.Run(DateTime.UtcNow, 120, 2);
            foreach (string line in scenario.Logs)
            {
                Assert(line.IndexOf(Pipe, StringComparison.Ordinal) < 0, "pipe path leaked into the log");
            }
            Assert(supervisor.ProbeChecks == 1, "expected the scripted recovery to run");
            // The path still reaches the launcher: the handoff is never weakened into a guess.
            Assert(
                scenario.Bodies.Exists(delegate(string body) { return body.Contains(JString(Pipe)); }),
                "the handoff POST must still carry the inherited pipe path: bodies="
                    + string.Join("|", scenario.Bodies.ToArray()));
            Assert(
                scenario.Bodies.Exists(delegate(string body) { return body.Length == 0; }),
                "the probe must not resend the pipe path");
        }

        private static void Classification()
        {
            Assert(HandoffSupervisor.ClassifyHandoff(Accepted()) == HandoffOutcome.Accepted, "200 accepted");
            Assert(HandoffSupervisor.ClassifyHandoff(Pending()) == HandoffOutcome.Pending, "202 pending");
            Assert(HandoffSupervisor.ClassifyHandoff(ProbeUnhealthy()) == HandoffOutcome.Retry, "409 handoff");
            Assert(HandoffSupervisor.ClassifyHandoff(Unreachable()) == HandoffOutcome.Retry, "unreachable handoff");
            Assert(HandoffSupervisor.ClassifyHandoff(Response(400, "{}")) == HandoffOutcome.Rejected, "400 handoff");
            Assert(HandoffSupervisor.ClassifyHandoff(Response(403, "{}")) == HandoffOutcome.Rejected, "403 handoff");
            Assert(HandoffSupervisor.ClassifyHandoff(Response(200, "{\"accepted\":false}")) == HandoffOutcome.Retry,
                "200 without accepted=true is not a handoff");
            Assert(HandoffSupervisor.ClassifyProbe(ProbeHealthy()) == ProbeOutcome.Healthy, "healthy probe");
            Assert(HandoffSupervisor.ClassifyProbe(ProbeUnhealthy()) == ProbeOutcome.Unhealthy, "409 probe");
            Assert(HandoffSupervisor.ClassifyProbe(Unreachable()) == ProbeOutcome.Unhealthy, "unreachable probe");
            Assert(HandoffSupervisor.ClassifyProbe(Response(401, "{}")) == ProbeOutcome.Rejected, "401 probe");
            Assert(
                HandoffSupervisor.ClassifyProbe(Probe(200, "{\"connected\":true,\"pipeSource\":\"current_environment\"}"))
                    == ProbeOutcome.Unhealthy,
                "only pipeSource=handoff proves the handoff survived");
        }

        private static Scenario Healthy()
        {
            return new Scenario();
        }

        private static HandoffSupervisor Supervisor(Scenario scenario)
        {
            return new HandoffSupervisor(
                "http://127.0.0.1:1/",
                "token",
                Pipe,
                2000,
                delegate(HandoffRequest request)
                {
                    scenario.Calls.Add(request.Url);
                    scenario.Bodies.Add(request.Body);
                    if (scenario.Replies.Count > 0)
                    {
                        return scenario.Replies.Dequeue();
                    }

                    return request.Url.EndsWith("/probe", StringComparison.Ordinal)
                        ? scenario.ProbeFallback
                        : scenario.HandoffFallback;
                },
                delegate(string line) { scenario.Logs.Add(line); },
                delegate(int milliseconds)
                {
                    scenario.Sleeps.Add(milliseconds);
                    return true;
                },
                Backoff);
        }

        private static HandoffResponse Accepted()
        {
            return Response(200, "{\"accepted\":true,\"source\":\"desktop_environment\",\"desktop_owner_bound\":true}");
        }

        private static HandoffResponse Pending()
        {
            return Response(202, "{\"accepted\":false,\"pending\":true,\"source\":\"desktop_environment\"}");
        }

        private static HandoffResponse ProbeHealthy()
        {
            return Probe(200, "{\"connected\":true,\"pipeSource\":\"handoff\",\"toolCount\":42}");
        }

        private static HandoffResponse ProbeUnhealthy()
        {
            return Probe(409, "{\"connected\":false,\"error\":\"desktop_tools_pipe_unavailable\"}");
        }

        private static HandoffResponse Unreachable()
        {
            return new HandoffResponse { Status = 0, Body = "ConnectFailure" };
        }

        private static HandoffResponse Probe(int status, string body)
        {
            return Response(status, body);
        }

        private static HandoffResponse Response(int status, string body)
        {
            return new HandoffResponse { Status = status, Body = body };
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition)
            {
                throw new InvalidOperationException("self-check failed: " + message);
            }
        }
    }

    private static void StopHandoff(ManualResetEvent stopSignal)
    {
        if (stopSignal != null)
        {
            stopSignal.Set();
        }
    }

    private static HandoffResponse Send(HandoffRequest request)
    {
        try
        {
            HttpWebRequest webRequest = (HttpWebRequest)WebRequest.Create(request.Url);
            webRequest.Method = "POST";
            webRequest.Proxy = null;
            webRequest.AllowAutoRedirect = false;
            webRequest.Timeout = request.TimeoutMs;
            webRequest.ReadWriteTimeout = request.TimeoutMs;
            webRequest.Headers["authorization"] = "Bearer " + request.Token;
            byte[] payload = Encoding.UTF8.GetBytes(request.Body);
            webRequest.ContentLength = payload.Length;
            if (payload.Length > 0)
            {
                webRequest.ContentType = "application/json";
                using (Stream stream = webRequest.GetRequestStream())
                {
                    stream.Write(payload, 0, payload.Length);
                }
            }

            return ReadResponse(webRequest.GetResponse() as HttpWebResponse);
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            return response != null
                ? ReadResponse(response)
                : new HandoffResponse { Status = 0, Body = error.Status.ToString() };
        }
        catch (Exception error)
        {
            return new HandoffResponse { Status = 0, Body = error.GetType().Name };
        }
    }

    private static HandoffResponse ReadResponse(HttpWebResponse response)
    {
        HandoffResponse result = new HandoffResponse();
        try
        {
            result.Status = (int)response.StatusCode;
            using (Stream stream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            {
                result.Body = reader.ReadToEnd();
            }
        }
        catch (Exception error)
        {
            result.Body = error.GetType().Name;
        }
        finally
        {
            response.Close();
        }

        return result;
    }

    private static string Clip(string value, int maxLength)
    {
        if (value == null)
        {
            return null;
        }

        string collapsed = value.Replace("\r", " ").Replace("\n", " ").Trim();
        return collapsed.Length <= maxLength ? collapsed : collapsed.Substring(0, maxLength) + "...";
    }

    private sealed class Resolution
    {
        public string Path;
        public string Source;
        public long Length;
        public string LastWriteUtc;
        public List<string> Candidates = new List<string>();
    }

    // The real binary is resolved only from Desktop-owned locations. CODEX_CLI_PATH and PATH are
    // never consulted, so the trampoline cannot re-enter itself or hit an unrelated codex on PATH.
    private static Resolution ResolveRealCodex(Config config)
    {
        Resolution resolution = new Resolution();

        string overridePath = config.RealCodexPath;
        if (string.IsNullOrEmpty(overridePath))
        {
            overridePath = Environment.GetEnvironmentVariable(OverrideEnvName);
        }

        if (!string.IsNullOrEmpty(overridePath) && File.Exists(overridePath))
        {
            resolution.Path = overridePath.Trim();
            resolution.Source = "env_override";
        }

        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        List<string> registered = Collect(
            Path.Combine(localAppData, "OpenAI", "Codex", "bin"),
            "codex.exe");
        if (resolution.Path == null && registered.Count > 0)
        {
            resolution.Path = registered[0];
            resolution.Source = "registered_core";
        }

        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        List<string> packaged = CollectPackaged(Path.Combine(programFiles, "WindowsApps"));
        if (resolution.Path == null && packaged.Count > 0)
        {
            resolution.Path = packaged[0];
            resolution.Source = "windowsapps_resources";
        }

        resolution.Candidates.AddRange(registered);
        resolution.Candidates.AddRange(packaged);

        if (resolution.Path != null && File.Exists(resolution.Path))
        {
            FileInfo info = new FileInfo(resolution.Path);
            resolution.Length = info.Length;
            resolution.LastWriteUtc = Iso(info.LastWriteTimeUtc);
        }
        else
        {
            resolution.Path = null;
            resolution.Source = null;
        }

        return resolution;
    }

    // %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe - the copy Desktop registers and launches.
    private static List<string> Collect(string root, string leafName)
    {
        List<string> found = new List<string>();
        try
        {
            if (!Directory.Exists(root))
            {
                return found;
            }

            foreach (string directory in Directory.GetDirectories(root))
            {
                string candidate = Path.Combine(directory, leafName);
                if (File.Exists(candidate))
                {
                    found.Add(candidate);
                }
            }
        }
        catch (Exception)
        {
            return found;
        }

        found.Sort(NewestFirst);
        return found;
    }

    // C:\Program Files\WindowsApps\OpenAI.Codex_*\app\resources\codex.exe - the packaged core.
    private static List<string> CollectPackaged(string windowsApps)
    {
        List<string> found = new List<string>();
        try
        {
            if (!Directory.Exists(windowsApps))
            {
                return found;
            }

            foreach (string package in Directory.GetDirectories(windowsApps, "OpenAI.Codex_*"))
            {
                string candidate = Path.Combine(package, "app", "resources", "codex.exe");
                if (File.Exists(candidate))
                {
                    found.Add(candidate);
                }
            }
        }
        catch (Exception)
        {
            return found;
        }

        found.Sort(NewestFirst);
        return found;
    }

    private static int NewestFirst(string left, string right)
    {
        return File.GetLastWriteTimeUtc(right).CompareTo(File.GetLastWriteTimeUtc(left));
    }

    // "<exe>" plus the parent's argument tail, byte for byte.
    private static string ArgumentTail(string commandLine)
    {
        if (string.IsNullOrEmpty(commandLine))
        {
            return string.Empty;
        }

        int index = 0;
        while (index < commandLine.Length && (commandLine[index] == ' ' || commandLine[index] == '\t'))
        {
            index++;
        }

        if (index < commandLine.Length && commandLine[index] == '"')
        {
            index++;
            while (index < commandLine.Length && commandLine[index] != '"')
            {
                index++;
            }
            if (index < commandLine.Length)
            {
                index++;
            }
        }
        else
        {
            while (index < commandLine.Length && commandLine[index] != ' ' && commandLine[index] != '\t')
            {
                index++;
            }
        }

        return commandLine.Substring(index);
    }

    private static string Quote(string value)
    {
        return "\"" + value + "\"";
    }

    private static bool SamePath(string left, string right)
    {
        if (string.IsNullOrEmpty(left) || string.IsNullOrEmpty(right))
        {
            return false;
        }

        try
        {
            return string.Equals(
                Path.GetFullPath(left).TrimEnd('\\'),
                Path.GetFullPath(right).TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static string OwnPath()
    {
        try
        {
            return System.Reflection.Assembly.GetEntryAssembly().Location;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    private static string ToolDirectory()
    {
        try
        {
            string directory = Path.GetDirectoryName(OwnPath());
            return string.IsNullOrEmpty(directory) ? Environment.CurrentDirectory : directory;
        }
        catch (Exception)
        {
            return Environment.CurrentDirectory;
        }
    }

    private static string SafeCurrentDirectory()
    {
        try
        {
            return Environment.CurrentDirectory;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string Iso(DateTime value)
    {
        return value.ToString("o", CultureInfo.InvariantCulture);
    }

    private static int CurrentProcessId()
    {
        try
        {
            return System.Diagnostics.Process.GetCurrentProcess().Id;
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static int ParentProcessId()
    {
        try
        {
            PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
            int returned;
            int status = NtQueryInformationProcess(
                System.Diagnostics.Process.GetCurrentProcess().Handle,
                0,
                ref info,
                Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)),
                out returned);
            if (status != 0)
            {
                return 0;
            }

            return unchecked((int)info.InheritedFromUniqueProcessId.ToInt64());
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static bool IsValidHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != new IntPtr(-1);
    }

    // Diagnostic directory: configured directory, then the tool directory, then TEMP.
    private static string ResolveLogDirectory(Config config)
    {
        List<string> candidates = new List<string>();
        if (!string.IsNullOrEmpty(config.LogDir))
        {
            candidates.Add(config.LogDir);
        }

        candidates.Add(Path.Combine(ToolDirectory(), "logs"));
        candidates.Add(Path.Combine(Path.GetTempPath(), "p5.8-bootstrap-trampoline"));

        foreach (string candidate in candidates)
        {
            try
            {
                Directory.CreateDirectory(candidate);
                using (FileStream probe = new FileStream(
                    Path.Combine(candidate, LogFileName),
                    FileMode.Append,
                    FileAccess.Write,
                    FileShare.ReadWrite))
                {
                    probe.Flush();
                }
                return candidate;
            }
            catch (Exception)
            {
            }
        }

        return Path.GetTempPath();
    }

    private static void Append(string logDirectory, string line)
    {
        string path = Path.Combine(logDirectory, LogFileName);
        for (int attempt = 0; attempt < 20; attempt++)
        {
            try
            {
                using (FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
                {
                    writer.WriteLine(line);
                }
                return;
            }
            catch (Exception)
            {
                Thread.Sleep(25);
            }
        }
    }

    private sealed class JsonObject
    {
        private readonly StringBuilder buffer = new StringBuilder("{");
        private bool first = true;

        public JsonObject Add(string key, string value)
        {
            return AddRaw(key, JString(value));
        }

        public JsonObject Add(string key, bool value)
        {
            return AddRaw(key, value ? "true" : "false");
        }

        public JsonObject Add(string key, int value)
        {
            return AddRaw(key, value.ToString(CultureInfo.InvariantCulture));
        }

        public JsonObject Add(string key, long value)
        {
            return AddRaw(key, value.ToString(CultureInfo.InvariantCulture));
        }

        public JsonObject AddArray(string key, IEnumerable<string> values)
        {
            StringBuilder array = new StringBuilder("[");
            bool arrayFirst = true;
            if (values != null)
            {
                foreach (string value in values)
                {
                    if (!arrayFirst)
                    {
                        array.Append(',');
                    }
                    arrayFirst = false;
                    array.Append(JString(value));
                }
            }
            array.Append(']');
            return AddRaw(key, array.ToString());
        }

        public override string ToString()
        {
            return buffer.ToString() + "}";
        }

        private JsonObject AddRaw(string key, string raw)
        {
            if (!first)
            {
                buffer.Append(',');
            }
            first = false;
            buffer.Append(JString(key)).Append(':').Append(raw);
            return this;
        }
    }

    private static string JString(string value)
    {
        if (value == null)
        {
            return "null";
        }

        StringBuilder escaped = new StringBuilder(value.Length + 2);
        escaped.Append('"');
        foreach (char character in value)
        {
            switch (character)
            {
                case '"': escaped.Append("\\\""); break;
                case '\\': escaped.Append("\\\\"); break;
                case '\n': escaped.Append("\\n"); break;
                case '\r': escaped.Append("\\r"); break;
                case '\t': escaped.Append("\\t"); break;
                default:
                    if (character < ' ')
                    {
                        escaped.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        escaped.Append(character);
                    }
                    break;
            }
        }
        escaped.Append('"');
        return escaped.ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr process,
        int informationClass,
        ref PROCESS_BASIC_INFORMATION information,
        int informationLength,
        out int returnLength);
}
