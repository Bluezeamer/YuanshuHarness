import { useEffect, useRef, useState } from "react";
import type { SkillFile } from "../../../../api/skillLibrary";
import { Button, InlineNotice, Modal } from "../../../../ui";
import type { SkillsStore } from "./store";

const ENTRY = "SKILL.md";

// 文件树：目录只是分组标题，文件才可点。路径按字典序，目录内的文件缩进一级。
function treeRows(files: readonly SkillFile[]) {
  const out: { path: string; name: string; depth: number; dir: boolean }[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!seen.has(dir)) {
        seen.add(dir);
        out.push({ path: dir, name: `${parts[i]}/`, depth: i, dir: true });
      }
    }
    out.push({
      path: f.path,
      name: parts[parts.length - 1] ?? f.path,
      depth: parts.length - 1,
      dir: false,
    });
  }
  return out;
}

export interface SkillInfoModalProps {
  name: string;
  description: string;
  store: SkillsStore;
  onClose: () => void;
}

// 技能详情（只读，宽 880px）：左文件树、右即时预览；默认 SKILL.md，切文件不关弹窗，不显示任何安装位置。
export function SkillInfoModal({
  name,
  description,
  store,
  onClose,
}: SkillInfoModalProps) {
  const [files, setFiles] = useState<SkillFile[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);

  useEffect(() => {
    let live = true;
    void store.files(name).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setFiles(r.data);
      setPath(
        r.data.find((f) => f.path === ENTRY)?.path ?? r.data[0]?.path ?? null,
      );
    });
    return () => {
      live = false;
    };
  }, [store, name]);

  useEffect(() => {
    if (path === null) return;
    const mine = ++ticket.current;
    setContent(null);
    void store.readFile(name, path).then((r) => {
      // 连点几个文件时只认最后一次
      if (mine !== ticket.current) return;
      setError(r.ok ? null : r.message);
      setContent(r.ok ? r.data : "");
    });
  }, [store, name, path]);

  return (
    <Modal
      open
      onClose={onClose}
      title={name}
      description={description || undefined}
      size="xl"
    >
      <div className="st-tl-info">
        <nav className="st-tl-tree" aria-label="文件树">
          {files === null && !error && (
            <p className="st-tl-dim t-aux">读取中…</p>
          )}
          {treeRows(files ?? []).map((r) =>
            r.dir ? (
              <div
                key={r.path}
                className="st-tl-tree-d t-mono"
                style={{ paddingLeft: 8 + r.depth * 12 }}
              >
                {r.name}
              </div>
            ) : (
              <Button
                key={r.path}
                variant="ghost"
                size="sm"
                className="st-tl-tree-f t-mono"
                data-path={r.path}
                aria-pressed={path === r.path}
                style={{ paddingLeft: 8 + r.depth * 12 }}
                onClick={() => setPath(r.path)}
              >
                {r.name}
              </Button>
            ),
          )}
        </nav>
        <div className="st-tl-pv">
          <div className="st-tl-pv-path t-mono" data-testid="sk-path">
            {path ?? "—"}
          </div>
          {error ? (
            <InlineNotice tone="danger">{error}</InlineNotice>
          ) : (
            <pre className="st-tl-pv-file t-mono" data-testid="sk-file">
              {content ?? "读取中…"}
            </pre>
          )}
        </div>
      </div>
    </Modal>
  );
}
