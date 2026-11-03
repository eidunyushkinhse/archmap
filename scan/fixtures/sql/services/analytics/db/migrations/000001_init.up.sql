CREATE TABLE `events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kind` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` JSON,
  PRIMARY KEY (`id`),
  KEY `kind_idx` (`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
