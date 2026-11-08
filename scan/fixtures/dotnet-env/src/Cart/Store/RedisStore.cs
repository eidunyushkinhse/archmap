using Microsoft.Extensions.Configuration;

namespace Cart.Store
{
    public class RedisStore
    {
        public RedisStore(IConfiguration configuration, string name)
        {
            bool.TryParse(configuration[Keys.Tracing], out var off);
            var dynamic = configuration[name];
            var joined = configuration["PREFIX_" + name];
        }
    }
}
