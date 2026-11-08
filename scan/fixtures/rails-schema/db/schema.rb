ActiveRecord::Schema[8.0].define(version: 2026_01_01_000000) do
  enable_extension "plpgsql"
  create_schema "billing"

  create_table "accounts", force: :cascade do |t|
    t.string "username", default: "", null: false
    t.datetime "created_at", null: false
    t.index ["username"], name: "index_accounts_on_username", unique: true
  end
  create_table "statuses", id: :uuid, force: :cascade do |t|
    t.references "account", null: false
    t.references "target", polymorphic: true
    t.text "text"
    t.timestamps
  end
  create_table "account_tags", id: false, force: :cascade do |t|
    t.bigint "account_id", null: false
    t.bigint "tag_id", null: false
  end
  create_table "settings", primary_key: "var", id: :string, force: :cascade do |t|
    t.jsonb "value"
    t.frobnicate_weird
  end
  create_view "status_stats", sql_definition: <<-SQL
      SELECT account_id, count(*) FROM statuses GROUP BY account_id
  SQL
  add_foreign_key "statuses", "accounts", on_delete: :cascade
  add_foreign_key "account_tags", "accounts", column: "account_id"
  add_foreign_key "account_tags", "tags"
  create_trigger("statuses_touch", :generated => true).
      on("statuses").
      before(:update) do
    <<-SQL_ACTIONS
      NEW.updated_at := now();
    SQL_ACTIONS
  end
end
