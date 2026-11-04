defmodule Shop.MixProject do
  def project do
    [app: :shop_ex, deps: deps()]
  end
  defp deps do
    [{:phoenix, "~> 1.7"}, {:ecto_sql, "~> 3.10"}]
  end
end
