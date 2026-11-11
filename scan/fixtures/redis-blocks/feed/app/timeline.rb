class Timeline
  include Redisable

  def remove(statuses)
    redis.pipelined do |pipeline|
      statuses.each do |status|
        unpush(status, pipeline)
      end
    end
    Redis.current.with do |conn|
      conn.publish('timeline:pool', 1)
    end
    redis.multi { |multi| multi.publish('timeline:multi', 1) }
    redis.pipelined do |pipeline|
      pipeline.multi do |tx|
        tx.publish('timeline:nested', 1)
      end
    end
    pipeline.publish('trap:after', 1)
  end

  def unpush(status, pipeline)
    return unless status.public?

    pipeline.publish('timeline:public', status)
    if status.media?
      pipeline.publish(status.local? ? 'timeline:local' : 'timeline:remote', status)
    end
    status.tags.each do |tag|
      pipeline.publish("timeline:hashtag:#{tag}", status)
    end
    pipeline.publish('timeline:local:only', status) if status.local?
  end

  def keep(status, pipeline)
    pipeline.publish('trap:not-called', status)
  end

  def save(record)
    ActiveRecord::Base.transaction do |t|
      t.publish('trap:transaction', record)
    end
    pool.with do |conn|
      conn.publish('trap:pool', record)
    end
  end
end
