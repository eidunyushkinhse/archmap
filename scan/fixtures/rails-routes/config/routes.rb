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
  resources :posts, except: [:destroy], concerns: :likeable, shallow: true do
    member do
      get :preview
    end
    collection { post :batch }
    get :stats, on: :member
    resources :comments
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

  # Необязательная группа: основная форма без группы; маршрут, совпавший с записанным, один.
  scope "(/locale/:locale)", defaults: { locale: nil } do
    get 'archive(/:page)', to: 'archive#index'
    get 'health', to: 'health#show'
  end

  devise_for :users, path: 'auth', path_names: { sign_in: 'login' }
  devise_for :admins
  devise_scope :user do
    get 'join', to: 'registrations#new'
  end

  draw(:api)
  draw(:legacy)
end
