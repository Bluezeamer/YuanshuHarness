// 数据库基线：把此前的迁移阶梯压成一份当前结构。原型期数据可重建：改结构的批次直接改这份、
// 合并后删数据目录重建，不写迁移；首个对外版本之后才开始在 db.ts 的 MIGRATIONS 末尾追加迁移。
export const BASELINE_SQL = `
CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         name TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       , directory_id TEXT, prompt_text TEXT, active_mode_id TEXT, seq_no INTEGER, lifecycle TEXT NOT NULL DEFAULT 'active', prompt_preset_id TEXT, mode_preset_ids TEXT
       , workspace_id TEXT, parent_session_id TEXT, fork_entry_id TEXT, unread_result INTEGER NOT NULL DEFAULT 0, unread_error INTEGER NOT NULL DEFAULT 0, preview TEXT, pinned INTEGER NOT NULL DEFAULT 0);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE permission_rules (
         id TEXT PRIMARY KEY,
         directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
         kind TEXT NOT NULL,
         access TEXT,
         value TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE(directory_id, kind, access, value)
       );

CREATE TABLE secrets (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         kind TEXT NOT NULL,
         ciphertext BLOB NOT NULL,
         created_at TEXT NOT NULL
       , purpose TEXT, scope_kind TEXT NOT NULL DEFAULT 'any', scope_target TEXT, tier TEXT NOT NULL DEFAULT 'rules', value_kind TEXT NOT NULL DEFAULT 'text', file_meta TEXT, policy TEXT NOT NULL DEFAULT 'allow', expiry TEXT, rotated_at TEXT, var_group TEXT, last_used_at TEXT);

CREATE TABLE environments (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         host TEXT NOT NULL,
         port INTEGER NOT NULL DEFAULT 22,
         username TEXT NOT NULL,
         os TEXT NOT NULL DEFAULT 'posix',
         secret_id TEXT REFERENCES secrets(id),
         created_at TEXT NOT NULL
       , host_key TEXT, jump_id TEXT REFERENCES environments(id), policy_json TEXT, host_key_pending TEXT, host_key_changed_from TEXT, host_key_accepted_at TEXT, last_active_at TEXT);

CREATE TABLE "directories" (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         path TEXT NOT NULL,
         environment_id TEXT NOT NULL DEFAULT 'local',
         created_at TEXT NOT NULL,
         UNIQUE(environment_id, path)
       );

CREATE TABLE audit_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         session_id TEXT,
         actor TEXT NOT NULL,
         kind TEXT NOT NULL,
         environment_id TEXT,
         summary TEXT NOT NULL,
         detail TEXT
       );

CREATE TABLE skills (
         name TEXT PRIMARY KEY,
         description TEXT NOT NULL,
         scope TEXT NOT NULL,
         source TEXT NOT NULL,
         hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       , version TEXT, locked_version TEXT, origin TEXT, enabled INTEGER NOT NULL DEFAULT 1, latest_version TEXT, versions TEXT, checked_at TEXT);

CREATE TABLE workspace_capabilities (
         workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
         kind TEXT NOT NULL,
         name TEXT NOT NULL,
         PRIMARY KEY (workspace_id, kind, name)
       );

CREATE TABLE mcp_servers (
         name TEXT PRIMARY KEY,
         config TEXT NOT NULL,
         tools TEXT,
         tools_at TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       , approval TEXT NOT NULL DEFAULT 'ask', enabled INTEGER NOT NULL DEFAULT 1, exposure TEXT NOT NULL DEFAULT 'direct', tool_exposure TEXT, timeout REAL, oauth TEXT, description TEXT, handshake TEXT, latest_version TEXT, is_global INTEGER NOT NULL DEFAULT 0);

CREATE TABLE subagents (
         child_id TEXT PRIMARY KEY,
         parent_id TEXT NOT NULL,
         depth INTEGER NOT NULL,
         task TEXT NOT NULL,
         spec TEXT NOT NULL,
         state TEXT NOT NULL,
         result TEXT,
         report TEXT,
         denied INTEGER NOT NULL DEFAULT 0,
         denied_reasons TEXT NOT NULL DEFAULT '[]',
         counted INTEGER NOT NULL DEFAULT 1,
         run_id TEXT,
         phase TEXT,
         created_at TEXT NOT NULL,
         finished_at TEXT
       );

CREATE TABLE teams (
         lead_id TEXT PRIMARY KEY,
         board_seq INTEGER NOT NULL DEFAULT 0,
         directory_id TEXT NOT NULL,
         created_at TEXT NOT NULL
       );

CREATE TABLE team_members (
         child_id TEXT PRIMARY KEY,
         lead_id TEXT NOT NULL,
         name TEXT NOT NULL,
         agent_name TEXT NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE (lead_id, name)
       );

CREATE TABLE hooks (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         point TEXT NOT NULL,
         matcher TEXT NOT NULL DEFAULT '',
         command TEXT NOT NULL,
         timeout_sec INTEGER NOT NULL DEFAULT 30,
         enabled INTEGER NOT NULL DEFAULT 1,
         directory_id TEXT REFERENCES directories(id) ON DELETE CASCADE,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );

CREATE TABLE jobs (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         name TEXT NOT NULL,
         label TEXT NOT NULL,
         input TEXT NOT NULL DEFAULT '',
         ref TEXT,
         state TEXT NOT NULL,
         exit_code INTEGER,
         remind_ms INTEGER NOT NULL,
         told INTEGER NOT NULL DEFAULT 0,
         started_at TEXT NOT NULL,
         ended_at TEXT
       );

CREATE TABLE providers (
         id TEXT PRIMARY KEY,
         custom INTEGER NOT NULL,
         name TEXT,
         slug TEXT UNIQUE,
         api TEXT,
         base_url TEXT,
         method TEXT NOT NULL,
         key_storage TEXT NOT NULL,
         env_variable TEXT,
         command TEXT,
         secret_id TEXT,
         compat TEXT,
         models TEXT NOT NULL DEFAULT '[]',
         last_test TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       , auth_header TEXT, max_concurrent INTEGER);

CREATE TABLE variable_refs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         directory_id TEXT NOT NULL,
         host_id TEXT NOT NULL,
         run_id TEXT,
         tool_call_id TEXT NOT NULL,
         at TEXT NOT NULL,
         result TEXT NOT NULL
       , command TEXT);

CREATE TABLE tool_rules (
         tool TEXT PRIMARY KEY,
         inside TEXT NOT NULL,
         outside TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );

CREATE TABLE session_configs (
         session_id TEXT PRIMARY KEY,
         config TEXT NOT NULL,
         rev INTEGER NOT NULL,
         updated_at TEXT NOT NULL
       );

CREATE TABLE session_state (
         session_id TEXT PRIMARY KEY,
         goal TEXT,
         todo TEXT,
         compact TEXT,
         updated_at TEXT NOT NULL
       );

CREATE TABLE session_files (
         session_id TEXT NOT NULL,
         host_id TEXT NOT NULL,
         path TEXT NOT NULL,
         tokens INTEGER NOT NULL,
         reads INTEGER NOT NULL,
         modified INTEGER NOT NULL,
         truncated INTEGER NOT NULL,
         last_at TEXT NOT NULL,
         PRIMARY KEY (session_id, host_id, path)
       );

CREATE TABLE calls (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         run_id TEXT,
         seq INTEGER NOT NULL,
         trigger TEXT NOT NULL,
         tool_name TEXT,
         duration_ms INTEGER NOT NULL,
         tokens_json TEXT NOT NULL,
         meta_json TEXT NOT NULL,
         msg_count INTEGER NOT NULL,
         response_z BLOB NOT NULL,
         created_at TEXT NOT NULL,
         UNIQUE(session_id, seq)
       );

CREATE TABLE latest_request (
         session_id TEXT PRIMARY KEY,
         request_z BLOB NOT NULL,
         updated_at TEXT NOT NULL
       );

CREATE TABLE turn_changes (
         session_id TEXT NOT NULL,
         turn INTEGER NOT NULL,
         path TEXT NOT NULL,
         status TEXT NOT NULL,
         added INTEGER NOT NULL,
         removed INTEGER NOT NULL,
         total INTEGER NOT NULL,
         mode TEXT NOT NULL,
         created_at TEXT NOT NULL, anchor_ts TEXT,
         PRIMARY KEY (session_id, turn, path)
       );

CREATE TABLE prompt_cards (
         id TEXT PRIMARY KEY,
         grp TEXT NOT NULL,
         title TEXT NOT NULL,
         body TEXT NOT NULL,
         builtin INTEGER NOT NULL,
         origin TEXT NOT NULL,
         copy_of TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       , sort_order INTEGER NOT NULL DEFAULT 0);

CREATE TABLE prompt_presets (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         name TEXT NOT NULL,
         description TEXT NOT NULL,
         active INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       , capabilities TEXT, caps_add TEXT, caps_remove TEXT);

CREATE TABLE prompt_nodes (
         id TEXT PRIMARY KEY,
         preset_id TEXT NOT NULL,
         position INTEGER NOT NULL,
         tag TEXT,
         title TEXT NOT NULL,
         slot_kind TEXT NOT NULL,
         channel TEXT NOT NULL,
         builtin INTEGER NOT NULL,
         items TEXT NOT NULL DEFAULT '[]'
       );

CREATE TABLE workspaces (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         group_id TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         pinned INTEGER NOT NULL DEFAULT 0,
         sort_order INTEGER NOT NULL DEFAULT 0,
         defaults TEXT NOT NULL DEFAULT '{}',
         review_mode TEXT NOT NULL DEFAULT 'append',
         review_text TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );

CREATE TABLE workspace_directories (
         workspace_id TEXT NOT NULL,
         position INTEGER NOT NULL,
         directory_id TEXT NOT NULL,
         PRIMARY KEY (workspace_id, directory_id)
       );

CREATE TABLE workspace_variables (
         workspace_id TEXT NOT NULL,
         variable_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
         PRIMARY KEY (workspace_id, variable_id)
       );

CREATE TABLE workspace_groups (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         tone INTEGER NOT NULL DEFAULT 0,
         collapsed INTEGER NOT NULL DEFAULT 0,
         sort_order INTEGER NOT NULL DEFAULT 0
       );

CREATE TABLE workspace_layouts (
         workspace_id TEXT PRIMARY KEY,
         revision INTEGER NOT NULL,
         document TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );

CREATE TABLE tool_descriptions (
         name TEXT PRIMARY KEY,
         description TEXT NOT NULL,
         updated_at TEXT NOT NULL
       );

-- 同一主机上目录名唯一（host:name 是 agent 的标识符）；附件区的行都叫 attachment，排除在外。
CREATE UNIQUE INDEX directories_name ON directories(environment_id, name) WHERE environment_id != 'attachment';

CREATE INDEX audit_log_session ON audit_log(session_id, id);

CREATE INDEX sessions_workspace ON sessions(workspace_id);

CREATE INDEX sessions_parent ON sessions(parent_session_id);

CREATE INDEX workspace_variables_variable ON workspace_variables(variable_id);

-- 同一目录至多是一个工作区的主目录（position 0），其余位置可重复引用。
CREATE UNIQUE INDEX workspace_primary ON workspace_directories(directory_id) WHERE position = 0;

CREATE INDEX audit_log_kind ON audit_log(kind, id);

CREATE INDEX subagents_parent ON subagents(parent_id);

CREATE INDEX team_members_lead ON team_members(lead_id);

CREATE INDEX hooks_point ON hooks(point);

CREATE INDEX jobs_session ON jobs(session_id, started_at);

CREATE INDEX jobs_ref ON jobs(ref);

CREATE INDEX variable_refs_directory ON variable_refs(directory_id, id);

CREATE INDEX variable_refs_name ON variable_refs(name, id);

CREATE INDEX prompt_cards_grp ON prompt_cards(grp);

CREATE INDEX prompt_presets_kind ON prompt_presets(kind);

CREATE INDEX prompt_nodes_preset ON prompt_nodes(preset_id, position);

CREATE TABLE browser_pages (
         id TEXT PRIMARY KEY,
         workspace_key TEXT NOT NULL,
         url TEXT NOT NULL,
         title TEXT NOT NULL DEFAULT '',
         user_opened INTEGER NOT NULL DEFAULT 0,
         controller TEXT NOT NULL,
         state TEXT NOT NULL,
         epoch INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         last_used_at TEXT NOT NULL
       );

CREATE TABLE browser_page_refs (
         page_id TEXT NOT NULL REFERENCES browser_pages(id) ON DELETE CASCADE,
         session_id TEXT NOT NULL,
         PRIMARY KEY (page_id, session_id)
       );

CREATE TABLE browser_steps (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         workspace_key TEXT NOT NULL,
         session_id TEXT NOT NULL,
         page_id TEXT NOT NULL,
         ts TEXT NOT NULL,
         tool TEXT NOT NULL,
         summary TEXT NOT NULL,
         url TEXT NOT NULL,
         title TEXT NOT NULL DEFAULT ''
       );

CREATE TABLE browser_logins (
         site TEXT PRIMARY KEY,
         enabled INTEGER NOT NULL DEFAULT 1,
         state BLOB NOT NULL,
         cookies INTEGER NOT NULL,
         origins INTEGER NOT NULL,
         saved_at TEXT NOT NULL
       );

CREATE INDEX browser_pages_workspace ON browser_pages(workspace_key);

CREATE INDEX browser_page_refs_session ON browser_page_refs(session_id);

CREATE INDEX browser_steps_session ON browser_steps(session_id, id);

CREATE TABLE devices (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         token_hash TEXT NOT NULL UNIQUE,
         created_at TEXT NOT NULL,
         last_used_at TEXT
       );

CREATE TABLE push_vapid (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         public_key TEXT NOT NULL,
         private_key BLOB NOT NULL
       );

CREATE TABLE push_subscriptions (
         device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
         endpoint TEXT NOT NULL,
         p256dh TEXT NOT NULL,
         auth TEXT NOT NULL,
         on_blocked INTEGER NOT NULL DEFAULT 1,
         on_error INTEGER NOT NULL DEFAULT 1,
         on_done INTEGER NOT NULL DEFAULT 0,
         policy TEXT NOT NULL DEFAULT 'unwatched',
         delay_sec INTEGER NOT NULL DEFAULT 30,
         created_at TEXT NOT NULL
       );

CREATE TABLE forwards (
         id TEXT PRIMARY KEY,
         workspace_key TEXT NOT NULL,
         env_id TEXT NOT NULL,
         port INTEGER NOT NULL,
         local_port INTEGER NOT NULL UNIQUE,
         created_at TEXT NOT NULL,
         UNIQUE (workspace_key, env_id, port)
       );

INSERT INTO meta (key, value) VALUES ('session_seq', '0');
`;
