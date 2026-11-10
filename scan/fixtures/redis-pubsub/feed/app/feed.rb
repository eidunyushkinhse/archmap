class Feed
  def push(status)
    redis.publish('timeline:public', status)
    redis.publish(status.local? ? 'timeline:public:local' : 'timeline:public:remote', status)
    redis.publish("timeline:#{status.id}", status)
    Redis.current.subscribe 'timeline:direct' do |on|
    end
    pipeline.publish('timeline:skip', status)
    @announcement.publish!
  end
end
