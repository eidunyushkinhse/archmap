ALTER TABLE `events` MODIFY `payload` JSON NOT NULL, CHANGE `kind` `event_kind` VARCHAR(80) NOT NULL;
RENAME TABLE `events` TO `raw_events`;
