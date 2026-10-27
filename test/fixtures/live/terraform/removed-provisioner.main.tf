removed {
  from = terraform_data.gone
  lifecycle { destroy = true }
  provisioner "local-exec" {
    when    = destroy
    command = "echo removed"
  }
}
module "child" { source = "./child" }
