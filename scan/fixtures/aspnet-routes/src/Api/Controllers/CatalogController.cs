namespace Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class CatalogController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpGet("{id}")]
    public async Task<IActionResult> GetAsync(int id) => Ok();

    [HttpPost("[action]")]
    [ProducesResponseType(201)]
    public IActionResult Import([FromBody] Item item) => Ok();

    private string Hidden => "[HttpGet(\"/in-string\")]";
}
