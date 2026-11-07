-- Таблица живёт недолго: три непонятые инструкции к ней менее важны, чем к живой.
CREATE TABLE post_fast (id int);
ALTER TABLE post_fast ADD (hot_rank int);
ALTER TABLE post_fast ADD (score int);
ALTER TABLE post_fast ADD (comments int);
DROP TABLE post_fast;
