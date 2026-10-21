CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
INSERT INTO session_v2 VALUES ('ses_fixture0001', 'global', NULL, 'one', :cwd, 'Fixture opencode title 1', '2.0.24', NULL, 1790845200000, 1790848800000);
INSERT INTO session_v2 VALUES ('ses_fixture0002', 'global', NULL, 'two', :cwd, 'Fixture opencode title 2', '2.0.24', NULL, 1790931600000, 1790935200000);
INSERT INTO session_v2 VALUES ('ses_fixture0003', 'global', 'ses_fixture0002', 'sub', :cwd, 'Fixture opencode subagent', '2.0.24', NULL, 1791018000000, 1791021600000);
INSERT INTO session_v2 VALUES ('ses_fixture0004', 'global', NULL, 'else', '/elsewhere', 'Fixture opencode elsewhere', '2.0.24', NULL, 1791104400000, 1791108000000);
INSERT INTO session_message VALUES ('msg_fixture0001', 'ses_fixture0001', 'user', 1, 1790845200000, 1790845200000, '{"text":"Fixture opencode prompt 1","files":[],"agents":[]}');
INSERT INTO session_message VALUES ('msg_fixture0002', 'ses_fixture0002', 'user', 1, 1790931600000, 1790931600000, '{"text":"Fixture opencode prompt 2","files":[],"agents":[]}');
