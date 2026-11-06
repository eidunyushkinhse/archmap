-- Имена без кавычек PostgreSQL складывает в нижний регистр: LANGUAGE это language.
CREATE TABLE LANGUAGE (id serial PRIMARY KEY, code varchar(3) NOT NULL);
CREATE TABLE post (id serial PRIMARY KEY, language_id int REFERENCES LANGUAGE);
CREATE TABLE post_like (person_id int NOT NULL, post_id int NOT NULL, score smallint);
CREATE TABLE post_saved (person_id int NOT NULL, post_id int NOT NULL);
-- Ловушка: имя в кавычках хранится как написано.
CREATE TABLE "Audit" ("Id" int);
