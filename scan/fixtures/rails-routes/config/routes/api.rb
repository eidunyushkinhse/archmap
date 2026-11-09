# frozen_string_literal: true

namespace :api do
  namespace :v1 do
    resources :statuses, only: [:index, :show]
    get '/instance', to: 'instances#show'
  end
end
