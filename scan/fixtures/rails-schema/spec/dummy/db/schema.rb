ActiveRecord::Schema[8.0].define(version: 2026_01_01_000000) do
  create_table "dummy_things", force: :cascade do |t|
    t.string "name"
  end
end
