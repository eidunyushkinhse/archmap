ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  enable_extension "plpgsql"

  create_table "articles", force: :cascade do |t|
    t.string "title", null: false
    t.references "user"
    t.timestamps
  end

  create_table "users", force: :cascade do |t|
    t.string "email", null: false
  end
end
