-- С11: та же база на встраиваемом диалекте для разработки и тестов.
CREATE TABLE owners (
  id         INTEGER IDENTITY PRIMARY KEY,
  first_name VARCHAR(30)
);
CREATE TABLE test_only (id INTEGER);
