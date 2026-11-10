class User < ApplicationRecord
  devise :database_authenticatable, :registerable,
         :recoverable, :invitable
  devise :validatable, timeout_in: 30.minutes
end
