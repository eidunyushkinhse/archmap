# frozen_string_literal: true

# Ловушка: get '/commented' в комментарии маршрутом не считается.
NOTE = "get '/in-string'"

def helper_path(name)
  get "/from-helper/#{name}"
end

Rails.application.routes.draw do
  root 'home#index'

  get 'health', to: 'health#show'
  post '/login' => 'sessions#create'
  match 'userinfo', via: [:get, :post], to: 'userinfo#show'
  match '*unmatched', via: :all, to: 'application#not_found'
  get "/#{ENV.fetch('PREFIX', 'x')}/dynamic", to: 'dynamic#show'

  mount Sidekiq::Web, at: 'sidekiq'

  concern :likeable do
    resources :likes, only: [:index]
  end

  resources :users, only: [:show]
  resources :posts, except: [:destroy], concerns: :likeable do
    member do
      get :preview
    end
    collection { post :batch }
    get :stats, on: :member
    resources :comments, only: [:index, :create]
  end
  resource :profile, only: [:show, :update]

  namespace :admin do
    resources :reports, only: :index
  end

  scope path: '.well-known' do
    get 'webfinger', to: 'webfinger#show'
  end

  constraints(format: :json) do
    get '/feed', to: 'feeds#show'
  end

  BODY = <<~TEXT
    get '/in-heredoc'
  TEXT

  draw(:api)
  draw(:legacy)
end
