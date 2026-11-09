FROM ruby:3.3
WORKDIR /app
COPY . .
RUN bundle install
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
