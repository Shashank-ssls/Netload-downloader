// netload portable launcher.
// A tiny console exe that runs the bundled Node runtime against the app, setting
// NETLOAD_HOME so the app keeps all its data/binaries inside this folder.
// Compiled at package time with the .NET Framework csc.exe that ships with Windows.
using System;
using System.Diagnostics;
using System.IO;

class NetloadLauncher {
    static int Main(string[] args) {
        string home = AppContext.BaseDirectory.TrimEnd('\\');
        string node = Path.Combine(home, "runtime", "node.exe");
        string app = Path.Combine(home, "app", "standalone.js");

        if (!File.Exists(node) || !File.Exists(app)) {
            Console.Error.WriteLine("netload: bundle is incomplete (missing runtime or app). Re-extract the full folder.");
            return 1;
        }

        string argLine = "\"" + app + "\"";
        foreach (string a in args) argLine += " \"" + a.Replace("\"", "\\\"") + "\"";

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = argLine;
        psi.UseShellExecute = false;          // inherit this console → interactive prompt works
        psi.WorkingDirectory = home;
        psi.EnvironmentVariables["NETLOAD_HOME"] = home;

        try {
            Process p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        } catch (Exception ex) {
            Console.Error.WriteLine("netload: failed to start runtime: " + ex.Message);
            return 1;
        }
    }
}
