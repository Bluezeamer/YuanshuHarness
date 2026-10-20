import { describe, expect, test } from "vitest";
import { isInteractive } from "./interactive.js";

const yes = async (line: string, sudo?: "password" | "nopasswd" | "unknown") =>
  (await isInteractive(line, sudo)).interactive;

describe("isInteractive：会等 tty 输入", () => {
  test.each([
    "su",
    "sudo -i",
    "sudo bash",
    "vim notes.txt",
    "nano /etc/hosts",
    "emacs file",
    "top",
    "htop",
    "tmux",
    "python3",
    "node",
    "bash",
    "sudo vim /etc/hosts",
    "ls && vim x",
    "ssh host",
    "ssh -p 22 user@host",
    "ssh -t host ls",
    "telnet host 23",
    "sftp host",
    "docker run -it ubuntu bash",
    "docker exec -ti c sh",
    "podman run --tty alpine",
    "kubectl exec -it pod -- sh",
  ])("%s", async (line) => {
    expect(await yes(line)).toBe(true);
  });

  test("sudo 需要密码且没有 -S / -n", async () => {
    expect(await yes("sudo apt-get update", "password")).toBe(true);
    expect(await yes("sudo -S apt-get update", "password")).toBe(false);
    expect(await yes("sudo -n apt-get update", "password")).toBe(false);
    expect(await yes("sudo apt-get update", "nopasswd")).toBe(false);
    expect(await yes("sudo apt-get update")).toBe(false);
  });

  test("给出原因", async () => {
    expect(await isInteractive("vim x")).toEqual({
      interactive: true,
      reason: "vim 是编辑器",
    });
  });
});

describe("isInteractive：不会等输入", () => {
  test.each([
    "ls -la",
    "echo hi | cat",
    "top -bn1",
    "vim -es +q file",
    "emacs --batch -l x.el",
    "nvim --headless +q",
    "python3 script.py",
    "python3 -c 'print(1)'",
    "node app.js",
    "bash -c 'echo hi'",
    "bash script.sh",
    "echo 'print(1)' | python3",
    "python3 < in.py",
    "ssh host ls",
    "ssh -p 22 host uptime",
    "ssh -o StrictHostKeyChecking=no host 'id'",
    "docker run ubuntu echo hi",
    "docker run -dit ubuntu",
    "docker exec c ls",
    "kubectl get pods",
    "sudo ls",
    "sudo -u root systemctl restart x",
  ])("%s", async (line) => {
    expect(await yes(line)).toBe(false);
  });

  test("空串与认不出的命令当非交互", async () => {
    expect(await yes("")).toBe(false);
    expect(await yes("some-unknown-tool --flag")).toBe(false);
  });
});
