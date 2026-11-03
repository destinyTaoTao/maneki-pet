using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// 直接读取并关闭 Win32 stdin HANDLE，不经过 Node 对标准管道的复制。
class MemoryPipeFault {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr handle, byte[] bytes, uint size, out uint read, IntPtr overlapped);
    static void Main(string[] args) {
        var input = GetStdHandle(-10);
        var line = new StringBuilder();
        var b = new byte[1];
        uint read;
        while (ReadFile(input, b, 1, out read, IntPtr.Zero) && read == 1 && b[0] != 10) line.Append((char)b[0]);
        var id = Regex.Match(line.ToString(), "\"id\":(\\d+)").Groups[1].Value;
        if (!CloseHandle(input)) throw new System.ComponentModel.Win32Exception();
        File.WriteAllText(args[0], System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
        Console.WriteLine("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":{}}");
        Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite);
    }
}
