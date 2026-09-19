-- Legacy column rename: the API-key column was named after the pre-rebrand
-- product name. Renamed in place to the current brand (preserves data).
ALTER TABLE settings RENAME COLUMN `contour_api_key` TO `quantour_api_key`;