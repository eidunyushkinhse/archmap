-- Склейка таблиц: новая таблица из запроса, старые удалены.
CREATE TABLE post_actions AS
SELECT person_id, post_id, max(score) AS score FROM post_like GROUP BY person_id, post_id;
DROP TABLE post_like;
ALTER TABLE post_actions ADD PRIMARY KEY (person_id, post_id);
ALTER TABLE post_actions RENAME CONSTRAINT post_actions_pkey TO post_actions_pk;
CREATE TABLE saved_tmp AS SELECT * FROM post_saved;
ALTER TABLE saved_tmp RENAME TO post_saved_combined;
DROP TABLE post_saved;
-- Ловушки: временная таблица в схему не попадает, удалённая подсказки не даёт.
CREATE TEMP TABLE scratch AS SELECT 1 AS x;
CREATE TABLE gone AS SELECT 1 AS x;
DROP TABLE gone;
ALTER TABLE post ADD (hidden boolean);
