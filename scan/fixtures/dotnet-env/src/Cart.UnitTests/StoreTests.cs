using Microsoft.Extensions.Configuration;

namespace Cart.UnitTests
{
    public class StoreTests
    {
        public void Reads(IConfiguration configuration)
        {
            var value = configuration["TEST_ONLY_KEY"];
        }
    }
}
