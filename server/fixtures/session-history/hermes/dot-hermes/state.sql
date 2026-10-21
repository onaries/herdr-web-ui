CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, cwd TEXT, title TEXT, last_activity_at REAL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
INSERT INTO sessions VALUES ('20261001_090000_fx0001', 'cli', NULL, 1790845200, NULL, :cwd, 'Fixture hermes title 1', 1790848800);
INSERT INTO sessions VALUES ('20261002_090000_fx0002', 'cli', NULL, 1790931600, NULL, :cwd, 'Fixture hermes title 2', 1790935200);
INSERT INTO sessions VALUES ('20261003_090000_fx0003', 'cli', '20261002_090000_fx0002', 1791018000, NULL, :cwd, 'Fixture hermes child', 1791021600);
INSERT INTO sessions VALUES ('20261004_090000_fx0004', 'cli', NULL, 1791104400, NULL, '/elsewhere', 'Fixture hermes elsewhere', 1791108000);
INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261001_090000_fx0001', 'system', 'Fixture system prompt', 1790845200);
INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261001_090000_fx0001', 'user', 'Fixture hermes prompt 1', 1790845201);
INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261002_090000_fx0002', 'user', 'Fixture hermes prompt 2', 1790931601);
