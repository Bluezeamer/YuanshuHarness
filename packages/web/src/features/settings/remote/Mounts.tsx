import type { DirectoryInfo } from "../../../api/directories";

/** 目录挂载：只显示引用，不在这里增删。 */
export function MountsSection({
  directories,
}: {
  directories: readonly DirectoryInfo[];
}) {
  return (
    <section className="st-block" aria-label="目录挂载">
      <header className="st-block-h t-group">
        <span>目录挂载</span>
        <span className="t-mono">{directories.length}</span>
      </header>
      {directories.length === 0 ? (
        <p className="st-rc-note t-aux">
          还没有目录挂在这条连接上。创建目录时选择这条连接作为环境即可。
        </p>
      ) : (
        <>
          <p className="st-rc-note t-aux">
            这里只显示引用，增删目录请在目录里操作。
          </p>
          <ul className="st-rc-mounts" aria-label="挂载的目录">
            {directories.map((w) => (
              <li key={w.id}>
                <span className="t-entry">{w.name}</span>
                <span className="st-rc-mount-path t-mono">{w.path}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
