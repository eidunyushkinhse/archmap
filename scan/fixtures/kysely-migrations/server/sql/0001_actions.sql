CREATE TABLE comment_like (person_id int NOT NULL, comment_id int NOT NULL, score smallint, published timestamptz);
-- Склейка таблиц (Lemmy): колонки по псевдонимам и именам списка SELECT.
CREATE TABLE comment_actions AS
SELECT
    max(published) AS liked,
    person_id,
    c.comment_id,
    max(score) = 1 AS vote_is_upvote -- комментарий в списке
FROM (SELECT person_id, comment_id, score, published FROM comment_like) AS c
GROUP BY person_id, c.comment_id;
DROP TABLE comment_like;
ALTER TABLE comment_actions
    ALTER COLUMN person_id SET NOT NULL,
    ADD PRIMARY KEY (person_id, comment_id);
CREATE TABLE comment_counts AS SELECT comment_id, count(*) FROM comment_actions GROUP BY comment_id;
