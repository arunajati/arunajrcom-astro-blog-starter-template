CREATE TABLE IF NOT EXISTS iatur_metrics (
	metric TEXT PRIMARY KEY CHECK (metric IN ('visit', 'download')),
	count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO iatur_metrics (metric, count) VALUES
	('visit', 347),
	('download', 81);
