# Ловушки: не воркер, публикация не читается.
class Account < ApplicationRecord
  # include Sidekiq::Worker
  def notify = PushUpdateWorker.perform_async(id)
end
