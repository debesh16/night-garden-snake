-- schema.sql - MySQL 8 schema for the optional online features of Night Garden Snake.
-- Load with:  mysql -u root -p < server/schema.sql

CREATE DATABASE IF NOT EXISTS snake CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE snake;

-- Players. Nickname-only by default; pass_hash is set only when a player
-- chooses a password (SHA-512 crypt, never stored in plain text).
CREATE TABLE IF NOT EXISTS users (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nickname    VARCHAR(16) NOT NULL,
  pass_hash   VARCHAR(128) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_nickname (nickname)
) ENGINE=InnoDB;

-- Every accepted run. score is the value recomputed by the server from the
-- replay, never the number the browser claimed.
CREATE TABLE IF NOT EXISTS scores (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  mode        TINYINT UNSIGNED NOT NULL,
  shape       TINYINT UNSIGNED NOT NULL,
  score       INT UNSIGNED NOT NULL,
  length      INT UNSIGNED NOT NULL,
  replay      VARBINARY(32768) NOT NULL,
  ip_hash     CHAR(16) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_scores_mode (mode, shape, score),
  KEY idx_scores_ip_time (ip_hash, created_at),
  CONSTRAINT fk_scores_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One scored daily attempt per player per day (the first one counts).
CREATE TABLE IF NOT EXISTS daily_runs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  day         INT NOT NULL,                 -- day number, #1 = 2026-01-01 UTC
  user_id     INT UNSIGNED NOT NULL,
  score_id    INT UNSIGNED NOT NULL,
  score       INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_daily_user (day, user_id),
  KEY idx_daily_top (day, score),
  CONSTRAINT fk_daily_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_score FOREIGN KEY (score_id) REFERENCES scores (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Community levels from the editor. data is the same base64url string the
-- share links use; the server validates it with the C core before storing.
CREATE TABLE IF NOT EXISTS levels (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  name        VARCHAR(40) NOT NULL,
  data        VARCHAR(2048) NOT NULL,
  ip_hash     CHAR(16) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_levels_time (created_at),
  CONSTRAINT fk_levels_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS level_likes (
  level_id    INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (level_id, user_id),
  CONSTRAINT fk_likes_level FOREIGN KEY (level_id) REFERENCES levels (id) ON DELETE CASCADE,
  CONSTRAINT fk_likes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A least-privilege account for the CGI program (change the password!).
CREATE USER IF NOT EXISTS 'snake_api'@'localhost' IDENTIFIED BY 'change-me-please';
GRANT SELECT, INSERT ON snake.* TO 'snake_api'@'localhost';
FLUSH PRIVILEGES;
