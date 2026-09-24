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
    private const string HandoffPath = "/launcher/desktop-tools-pipe";

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
        Config config = Config.Load();
        string logDirectory = ResolveLogDirectory(config);
        string ownPath = OwnPath();
        DateTime startedUtc = DateTime.UtcNow;
        string commandLine = Environment.CommandLine;
        string pipeValue = Environment.GetEnvironmentVariable(PipeEnvName);
        string cliValue = Environment.GetEnvironmentVariable(CliEnvName);
        Resolution resolution = ResolveRealCodex(config);

        Append(logDirectory, new JsonObject()
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
            .Add("pipe_value", pipeValue)
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

        StartHandoff(config, logDirectory, pipeValue, startedUtc);

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

    private sealed class HandoffJob
    {
        public Config Config;
        public string LogDirectory;
        public string PipePath;
        public DateTime StartedUtc;
        public int Attempts;
    }

    private sealed class HandoffResult
    {
        public int Status;
        public string Body;
        public bool Accepted;
        public bool Permanent;
    }

    // Runs on a background thread so the real codex.exe is never delayed by the handoff. The
    // bounded retries cover the window where LRM has not reconnected to Desktop IPC yet.
    private static void StartHandoff(Config config, string logDirectory, string pipeValue, DateTime startedUtc)
    {
        if (!config.HandoffEnabled
            || string.IsNullOrEmpty(pipeValue)
            || string.IsNullOrEmpty(config.BaseUrl)
            || string.IsNullOrEmpty(config.AuthToken))
        {
            return;
        }

        HandoffJob job = new HandoffJob();
        job.Config = config;
        job.LogDirectory = logDirectory;
        job.PipePath = pipeValue;
        job.StartedUtc = startedUtc;
        Thread worker = new Thread(HandoffWorker);
        worker.IsBackground = true;
        worker.Start(job);
    }

    private static void HandoffWorker(object state)
    {
        HandoffJob job = (HandoffJob)state;
        int[] delays = new int[] { 0, 1000, 2000, 3000, 5000, 8000, 13000, 21000, 34000, 55000 };
        for (int index = 0; index < delays.Length; index++)
        {
            if ((DateTime.UtcNow - job.StartedUtc).TotalSeconds > job.Config.HandoffDeadlineSeconds)
            {
                break;
            }

            if (delays[index] > 0)
            {
                Thread.Sleep(delays[index]);
            }

            job.Attempts = index + 1;
            HandoffResult result = PostHandoff(job);
            Append(job.LogDirectory, new JsonObject()
                .Add("event", result.Accepted ? "handoff_accepted" : (result.Permanent ? "handoff_rejected" : "handoff_retry"))
                .Add("ts_utc", Iso(DateTime.UtcNow))
                .Add("probe_pid", CurrentProcessId())
                .Add("attempt", job.Attempts)
                .Add("elapsed_ms", (int)(DateTime.UtcNow - job.StartedUtc).TotalMilliseconds)
                .Add("http_status", result.Status)
                .Add("response_body", Clip(result.Body, 400))
                .ToString());
            if (result.Accepted || result.Permanent)
            {
                return;
            }
        }

        Append(job.LogDirectory, new JsonObject()
            .Add("event", "handoff_giving_up")
            .Add("ts_utc", Iso(DateTime.UtcNow))
            .Add("probe_pid", CurrentProcessId())
            .Add("attempts", job.Attempts)
            .Add("elapsed_ms", (int)(DateTime.UtcNow - job.StartedUtc).TotalMilliseconds)
            .ToString());
    }

    private static HandoffResult PostHandoff(HandoffJob job)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(job.Config.BaseUrl + HandoffPath);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.Timeout = job.Config.HandoffTimeoutSeconds * 1000;
            request.ReadWriteTimeout = job.Config.HandoffTimeoutSeconds * 1000;
            request.Headers["authorization"] = "Bearer " + job.Config.AuthToken;
            byte[] payload = Encoding.UTF8.GetBytes("{\"pipePath\":" + JString(job.PipePath) + "}");
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }

            return ReadHandoffResponse(request.GetResponse() as HttpWebResponse);
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            if (response != null)
            {
                return ReadHandoffResponse(response);
            }

            return new HandoffResult { Status = 0, Body = error.Status.ToString(), Accepted = false, Permanent = false };
        }
        catch (Exception error)
        {
            return new HandoffResult { Status = 0, Body = error.GetType().Name, Accepted = false, Permanent = false };
        }
    }

    // 400/401/403 are deterministic answers: retrying them cannot turn into an acceptance.
    private static HandoffResult ReadHandoffResponse(HttpWebResponse response)
    {
        HandoffResult result = new HandoffResult();
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

        result.Accepted = result.Status == 200 && result.Body != null && result.Body.Contains("\"accepted\":true");
        result.Permanent = result.Status == 400 || result.Status == 401 || result.Status == 403;
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
