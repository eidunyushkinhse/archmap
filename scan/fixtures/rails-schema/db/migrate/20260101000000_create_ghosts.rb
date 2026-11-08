class CreateGhosts < ActiveRecord::Migration[8.0]
  def change
    create_table "ghosts" do |t|
      t.string "name"
    end
  end
end
